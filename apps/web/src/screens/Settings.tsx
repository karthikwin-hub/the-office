import { type Business, Gstin, type Settings } from "@office/contracts";
import { inr } from "@office/engine";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { q } from "../api/queries";
import { isOwner, Page, PageHead, Section } from "./common";
import { AccountSettings } from "./SettingsAccount";
import { OfficeSettings } from "./SettingsOffice";
import { OnboardingSettings } from "./SettingsOnboarding";
import { SkinPicker } from "./SettingsSkin";
import { SocialSettings } from "./SettingsSocial";
import { WhatsAppSettings } from "./SettingsWhatsApp";

export function SettingsScreen() {
  const settings = useQuery(q.settings());
  return (
    <Page ready={Boolean(settings.data)} error={settings.error}>
      {settings.data ? <SettingsForm s={settings.data} /> : null}
    </Page>
  );
}

/** The owner enters the business once; the GSTIN fixes the state and PAN, so it cannot be changed after. */
function BusinessForm({ b }: { b: Business }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ ...b, turnover: String(Math.round(b.prevYearTurnoverPaise / 100)) });
  const [saved, setSaved] = useState(false);
  const gstin = form.gstin.trim().toUpperCase();
  const gstinBad = !b.gstin && gstin !== "" && !Gstin.safeParse(gstin).success;
  const turnover = Number(form.turnover.replace(/[,\s]/g, ""));
  const save = useMutation({
    mutationFn: () => {
      const { turnover: _t, ...business } = form;
      return api.saveSettings({ business: { ...business, gstin: b.gstin || gstin, tan: form.tan.trim().toUpperCase(), prevYearTurnoverPaise: Math.round((Number.isFinite(turnover) ? turnover : 0) * 100) } });
    },
    onSuccess: (s) => {
      setForm({ ...s.business, turnover: String(Math.round(s.business.prevYearTurnoverPaise / 100)) });
      setSaved(true);
      void qc.invalidateQueries();
    },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm({ ...form, [k]: e.target.value });
  };
  const text = (k: "name" | "legalName" | "owner" | "tan" | "email" | "phone" | "accountantFirm", label: string, extra: { type?: string; placeholder?: string; className?: string } = {}) => (
    <div className="field">
      <label htmlFor={`b-${k}`}>{label}</label>
      <input id={`b-${k}`} className={`input ${extra.className ?? ""}`} type={extra.type ?? "text"} placeholder={extra.placeholder} value={form[k]} onChange={set(k)} />
    </div>
  );

  return (
    <form
      className="settings-form business-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset>
        <legend className="h2">Business</legend>
        {!b.gstin ? <p className="field-help business-intro">Your agents put these details on invoices, returns and reminders. Fill in what you have; you can come back for the rest.</p> : null}
        <div className="settings-grid">
          {text("name", "Name customers know")}
          {text("legalName", "Legal name", { placeholder: "As on your GST certificate" })}
          <div className="field">
            <label htmlFor="b-gstin">GSTIN</label>
            <input id="b-gstin" className="input code" value={b.gstin || form.gstin} readOnly={Boolean(b.gstin)} maxLength={15} placeholder="27ABCDE1234F1Z5" aria-invalid={gstinBad} aria-describedby="b-gstin-help" onChange={set("gstin")} />
            <span id="b-gstin-help" className="field-help">{b.gstin ? `State ${b.stateCode}, PAN ${b.pan}. Fixed once entered.` : gstinBad ? "That is not a valid GSTIN: 15 characters, starting with the state code." : "Sets your state and PAN. It cannot be changed later."}</span>
          </div>
          {text("tan", "TAN", { className: "code", placeholder: "MUMA12345B" })}
          {text("owner", "Your name", { placeholder: "How your agents address you" })}
          {text("email", "Business email", { type: "email" })}
          {text("phone", "Phone", { type: "tel" })}
          <div className="field">
            <label htmlFor="b-turnover">Turnover last year</label>
            <div className="input-suffix input-suffix-wide">
              <span>₹</span>
              <input id="b-turnover" className="input num" inputMode="numeric" value={form.turnover} onChange={set("turnover")} />
            </div>
            <span className="field-help">Above ₹10 crore, you deduct TDS under 194Q on large purchases.</span>
          </div>
          {text("accountantFirm", "Accountant's firm")}
          <div className="field field-wide">
            <label htmlFor="b-address">Address</label>
            <textarea id="b-address" className="input" rows={2} value={form.address} onChange={set("address")} />
          </div>
          <div className="field field-wide">
            <label htmlFor="b-bank">Bank details for invoices</label>
            <input id="b-bank" className="input" placeholder="Bank, account number, IFSC" value={form.bank} onChange={set("bank")} />
          </div>
        </div>
        <div className="approval-actions">
          <button type="submit" className="btn btn-primary" disabled={save.isPending || gstinBad || !form.name.trim()}>
            Save business
          </button>
          {saved ? <span role="status">Business saved</span> : null}
          {save.error ? <span className="form-error">{save.error.message}</span> : null}
        </div>
      </fieldset>
    </form>
  );
}

function SettingsForm({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const owner = isOwner();
  const [policy, setPolicy] = useState(s.reminderPolicy);
  const [digest, setDigest] = useState(s.digestTime);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api.saveSettings({ reminderPolicy: policy, digestTime: digest }),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries();
    },
  });
  const b = s.business;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    save.mutate();
  };

  return (
    <>
      <PageHead title="Settings" lede={owner ? undefined : "Only the owner can change the office's settings; how the office looks to you is yours to choose."} />
      <SkinPicker />
      <WhatsAppSettings />
      {owner ? (
        <BusinessForm b={b} />
      ) : (
        <Section title="Business">
          <dl className="details">
            <div><dt>Legal name</dt><dd>{b.legalName || "Not entered yet"}</dd></div>
            <div><dt>GSTIN</dt><dd className="num">{b.gstin || "Not entered yet"}</dd></div>
            <div><dt>PAN</dt><dd className="num">{b.pan}</dd></div>
            <div><dt>TAN</dt><dd className="num">{b.tan}</dd></div>
            <div><dt>Address</dt><dd>{b.address}</dd></div>
            <div><dt>Turnover last year</dt><dd>{inr(b.prevYearTurnoverPaise, { symbol: true, rupees: true })}, so TDS under 194Q applies to purchases above ₹50 lakh from one supplier</dd></div>
            <div><dt>Accountant</dt><dd>{b.accountantFirm}</dd></div>
          </dl>
        </Section>
      )}
      <OfficeSettings />
      <AccountSettings />
      <Section title="Getting documents in">
        <p>
          Forward bills and invoices to <strong className="num">{s.ingestEmail}</strong>, or upload them on the Accountant's room. The Accountant reads each one within a few minutes.
        </p>
      </Section>
      <OnboardingSettings b={b} />
      <form onSubmit={submit} className="settings-form">
        <fieldset disabled={!owner}>
          <legend className="h2">Reminders and digest</legend>
          <div className="settings-grid">
            <div className="field">
              <label htmlFor="first">Friendly reminder after</label>
              <div className="input-suffix">
                <input id="first" className="input num" type="number" min={1} max={60} value={policy.firstAfterDays} onChange={(e) => setPolicy({ ...policy, firstAfterDays: Number(e.target.value) })} />
                <span>days overdue</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="firm">Firm reminder after</label>
              <div className="input-suffix">
                <input id="firm" className="input num" type="number" min={2} max={90} value={policy.firmAfterDays} onChange={(e) => setPolicy({ ...policy, firmAfterDays: Number(e.target.value) })} />
                <span>days overdue</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="final">Final notice after</label>
              <div className="input-suffix">
                <input id="final" className="input num" type="number" min={3} max={180} value={policy.finalAfterDays} onChange={(e) => setPolicy({ ...policy, finalAfterDays: Number(e.target.value) })} />
                <span>days overdue</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="from">Send reminders from</label>
              <input id="from" className="input" type="email" value={policy.sendFrom} onChange={(e) => setPolicy({ ...policy, sendFrom: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="digest">Morning digest at</label>
              <input id="digest" className="input num" type="time" value={digest} onChange={(e) => setDigest(e.target.value)} />
            </div>
          </div>
          {policy.firstAfterDays >= policy.firmAfterDays || policy.firmAfterDays >= policy.finalAfterDays ? <p className="form-error">Each reminder must come after the one before it.</p> : null}
          <div className="approval-actions">
            <button type="submit" className="btn btn-primary" disabled={save.isPending || policy.firstAfterDays >= policy.firmAfterDays || policy.firmAfterDays >= policy.finalAfterDays}>
              Save settings
            </button>
            {saved ? <span role="status">Settings saved</span> : null}
          </div>
        </fieldset>
      </form>
      <SocialSettings />
    </>
  );
}
