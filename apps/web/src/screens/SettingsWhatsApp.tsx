import { type JoinCode, WA_LANGUAGE_NAMES, WaLanguage, type WhatsAppStatus } from "@office/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, isLive } from "../api/client";
import { isOwner, Section } from "./common";

/** Each person links their own phone; the office then answers them on WhatsApp, in their language. */
export function WhatsAppSettings() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["whatsapp"], queryFn: api.whatsapp });
  const set = (s: WhatsAppStatus) => qc.setQueryData(["whatsapp"], s);
  const [code, setCode] = useState<JoinCode | null>(null);
  const getCode = useMutation({ mutationFn: api.whatsappCode, onSuccess: setCode });
  const save = useMutation({ mutationFn: api.saveWhatsApp, onSuccess: set });
  const unlink = useMutation({ mutationFn: api.unlinkWhatsApp, onSuccess: (s) => (set(s), setCode(null)) });
  const s = status.data;
  if (!s) return null;

  return (
    <Section title="Your WhatsApp" id="whatsapp">
      <p className="section-lede">
        Run the office from your own phone: see what is waiting, approve with "1 yes", ask questions, forward bills and send voice notes in your own language.
        {isOwner() ? "" : " As the accountant you can ask and forward; only the owner approves."}
      </p>
      {!s.available ? (
        <p className="field-help">
          {isOwner() ? "WhatsApp is not set up for this office yet. Add the WhatsApp Cloud API keys (WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID) as Worker secrets, then link your phone here." : "WhatsApp is not set up for this office yet. The owner can switch it on."}
        </p>
      ) : s.linked ? (
        <div className="wa-linked">
          <p>
            Linked to <span className="num">{s.number}</span>.{" "}
            <button type="button" className="btn btn-quiet btn-small" onClick={() => unlink.mutate()} disabled={unlink.isPending}>
              Unlink
            </button>
          </p>
          <div className="wa-fields">
            <label className="field">
              <span>Reply language</span>
              <select className="input" value={s.language} onChange={(e) => save.mutate({ language: e.target.value === "auto" ? "auto" : WaLanguage.parse(e.target.value) })}>
                <option value="auto">The language I write in</option>
                {WaLanguage.options.map((l) => (
                  <option key={l} value={l}>
                    {WA_LANGUAGE_NAMES[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="wa-check">
              <input type="checkbox" checked={s.digest} onChange={(e) => save.mutate({ digest: e.target.checked })} /> Send my morning digest on WhatsApp
            </label>
          </div>
          <p className="field-help">
            WhatsApp lets the office write to you free for 24 hours after your last message to it. Outside that window
            {s.template ? " the digest goes as your WhatsApp template, which Meta charges for." : " the digest comes by email, as now."}
          </p>
        </div>
      ) : code ? (
        <div className="wa-code" role="status">
          <p>
            From your own phone, send <strong className="num">JOIN {code.code}</strong> to {code.businessNumber ? <span className="num">{code.businessNumber}</span> : "the office's WhatsApp number"} within 15 minutes.
          </p>
          {code.link ? (
            <a className="btn btn-primary btn-small" href={code.link} target="_blank" rel="noreferrer">
              Open WhatsApp with the message ready
            </a>
          ) : null}
          {!isLive ? <p className="field-help">On this demo, type it into the phone in the Office Manager's room.</p> : null}
        </div>
      ) : (
        <p>
          <button type="button" className="btn btn-primary" onClick={() => getCode.mutate()} disabled={getCode.isPending}>
            Link my phone
          </button>
          {getCode.error ? <span className="form-error"> {getCode.error.message}</span> : null}
        </p>
      )}
    </Section>
  );
}
