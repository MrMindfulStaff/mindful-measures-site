// Project intake. Every request is saved to the private Blob store
// (BLOB_READ_WRITE_TOKEN, set by Vercel when the store is connected) and,
// once an email key is configured, sent to the team with a confirmation to
// the person who filled it in.
//
// Env: INTAKE_TO (team inbox, default info@reignos.com), EMAIL_FROM,
// EMAIL_FROM_NAME, and SENDGRID_API_KEY or RESEND_API_KEY.

import { put } from "@vercel/blob";

const NEEDS = [
  "Website design and build",
  "Custom platform",
  "Personal command center",
  "Production video",
  "AI assistant or automation",
  "REIGN demo",
  "ROSE, BES, Victoria LMS or Curbside",
  "Something else",
];
const TIMELINES = ["As soon as possible", "Within 1 to 3 months", "Within 3 to 6 months", "Just exploring"];
const BUDGETS = ["Under $5,000", "$5,000 to $15,000", "$15,000 to $50,000", "Over $50,000", "Not sure yet"];
const CONTACT = ["Email", "Phone call", "Text message"];

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(body) {
  const needs = Array.isArray(body.needs) ? body.needs.filter((n) => NEEDS.includes(n)) : [];
  const r = {
    needs,
    details: str(body.details, 4000),
    timeline: TIMELINES.includes(body.timeline) ? body.timeline : "",
    budget: BUDGETS.includes(body.budget) ? body.budget : "",
    link: str(body.link, 300),
    name: str(body.name, 120),
    email: str(body.email, 200).toLowerCase(),
    phone: str(body.phone, 40),
    organization: str(body.organization, 160),
    contactBy: CONTACT.includes(body.contactBy) ? body.contactBy : "Email",
    heardFrom: str(body.heardFrom, 200),
  };
  const errors = [];
  if (!needs.length) errors.push("Choose at least one thing we can help with.");
  if (r.details.length < 10) errors.push("Tell us a little about the project.");
  if (!r.name) errors.push("Your name is required.");
  if (!EMAIL_RE.test(r.email)) errors.push("A valid email address is required.");
  if (r.contactBy !== "Email" && r.phone.replace(/\D/g, "").length < 10) errors.push("Add a phone number so we can call or text you.");
  return { r, errors };
}

function rows(r) {
  return [
    ["Name", r.name],
    ["Organization", r.organization],
    ["Email", r.email],
    ["Phone", r.phone],
    ["Preferred contact", r.contactBy],
    ["Needs", r.needs.join(", ")],
    ["Timeline", r.timeline],
    ["Budget", r.budget],
    ["Current site or link", r.link],
    ["Heard about us from", r.heardFrom],
  ].filter(([, v]) => v);
}

async function sendMail({ to, subject, text, html, replyTo }) {
  const from = process.env.EMAIL_FROM;
  const fromName = process.env.EMAIL_FROM_NAME || "Mindful Measures";
  if (!from) return { ok: false, error: "EMAIL_FROM not set" };
  let res;
  if (process.env.RESEND_API_KEY) {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to], reply_to: replyTo, subject, text, html }),
    });
  } else if (process.env.SENDGRID_API_KEY) {
    res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: fromName },
        reply_to: replyTo ? { email: replyTo } : undefined,
        subject,
        content: [{ type: "text/plain", value: text }, { type: "text/html", value: html }],
        tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
      }),
    });
  } else {
    return { ok: false, error: "no email key set" };
  }
  return res.ok ? { ok: true } : { ok: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

  // Bots: a hidden field people never see, and a form filled in under 3 seconds.
  if (str(body.website, 200) || (Number(body.elapsedMs) > 0 && Number(body.elapsedMs) < 3000)) {
    return res.status(200).json({ ok: true });
  }

  const { r, errors } = clean(body);
  if (errors.length) return res.status(400).json({ ok: false, errors });

  const receivedAt = new Date().toISOString();
  const id = `${receivedAt.slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    receivedAt,
    ...r,
    source: str(body.source, 60),
    ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim(),
    userAgent: str(req.headers["user-agent"] || "", 300),
  };

  let saved = false;
  try {
    await put(`intake/${id}.json`, JSON.stringify(record, null, 2), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
    });
    saved = true;
  } catch (e) {
    console.error("intake: blob save failed", e);
  }

  const team = process.env.INTAKE_TO || "info@reignos.com";
  const list = rows(r);
  const teamText = `New project request (${id})\n\n${list.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nAbout the project:\n${r.details}`;
  const teamHtml = `<h2 style="font-family:sans-serif">New project request</h2>
<table style="font-family:sans-serif;border-collapse:collapse">${list
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`)
    .join("")}</table>
<h3 style="font-family:sans-serif">About the project</h3><p style="font-family:sans-serif;white-space:pre-wrap">${esc(r.details)}</p>
<p style="font-family:sans-serif;color:#888;font-size:12px">Request ${esc(id)} · received ${esc(receivedAt)} · reply to this email to answer ${esc(r.name)} directly.</p>`;

  const notified = await sendMail({
    to: team,
    subject: `New project request: ${r.name}${r.organization ? `, ${r.organization}` : ""} (${r.needs.join(", ")})`,
    text: teamText,
    html: teamHtml,
    replyTo: r.email,
  });
  if (!notified.ok) console.error("intake: team email not sent:", notified.error);

  const first = r.name.split(/\s+/)[0];
  const confirmText = `Hi ${first},\n\nThanks for reaching out to Mindful Measures. We received your request (${r.needs.join(", ")}) and someone from our team will contact you by ${r.contactBy.toLowerCase()} soon.\n\nMindful Measures, Incorporated\nMilwaukee, Wisconsin\nmindfulmeasuresinc.com`;
  const confirmHtml = `<div style="font-family:sans-serif;line-height:1.5"><p>Hi ${esc(first)},</p>
<p>Thanks for reaching out to Mindful Measures. We received your request (<b>${esc(r.needs.join(", "))}</b>) and someone from our team will contact you by ${esc(r.contactBy.toLowerCase())} soon.</p>
<p>Mindful Measures, Incorporated<br>Milwaukee, Wisconsin<br><a href="https://mindfulmeasuresinc.com">mindfulmeasuresinc.com</a></p></div>`;
  const confirmed = await sendMail({ to: r.email, subject: "We received your request | Mindful Measures", text: confirmText, html: confirmHtml, replyTo: team });
  if (!confirmed.ok) console.error("intake: confirmation not sent:", confirmed.error);

  if (!saved && !notified.ok) {
    return res.status(500).json({ ok: false, errors: ["Something went wrong on our side. Please try again in a minute."] });
  }
  return res.status(200).json({ ok: true, id });
}
