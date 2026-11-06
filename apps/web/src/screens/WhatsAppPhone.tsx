import { BRAND } from "@office/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, isLive } from "../api/client";
import { SAMPLE_VOICE } from "../mocks/voice-samples";

type Bubble = { from: "you" | "office"; text: string; voice?: boolean };

const EXAMPLE: Bubble[] = [
  { from: "you", text: "desk" },
  { from: "office", text: "Hello Anil.\n\n3 waiting on your desk:\n\n1. Post the Shirke Traders bill (Accountant)\n2. Send reminders to 4 customers (Credit Controller)\n3. Reply to Santosh Electricals (Social media)\n\nReply like 1 yes, 2 no, 3 later, or all yes." },
  { from: "you", text: "1 haan 2 baad mein" },
  { from: "office", text: "1: मंज़ूर।\n\n2: बाद के लिए रखा।" },
];

/** Links in a reply stay tappable. */
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/\S+)/g).map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p.replace(/[).,]+$/, "")}>
            {p.includes("?figure=") ? "open the figure" : p.includes("/desk") ? "your desk" : p.replace(/^https?:\/\/[^/]+/, "") || p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** The office on WhatsApp, as the owner sees it on their phone. On the demo it answers for real, from the same books. */
export function WhatsAppPhone() {
  const qc = useQueryClient();
  const [chat, setChat] = useState<Bubble[]>(isLive ? EXAMPLE : [{ from: "office", text: "Send desk to see what is waiting, help for what I understand, or ask a question. You can also pick a voice note below." }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [chat]);

  const send = async (m: { text?: string; voice?: string }, shown: Bubble) => {
    setChat((c) => [...c, shown]);
    setBusy(true);
    try {
      const r = await api.whatsappDemo(m);
      setChat((c) => [...c, { from: "office", text: r.reply }]);
      void qc.invalidateQueries();
    } catch (e) {
      setChat((c) => [...c, { from: "office", text: e instanceof Error ? e.message : "The office did not answer." }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wa-demo">
      <div className="wa-phone" aria-label="The office on WhatsApp">
        <div className="wa-phone-head">
          <span className="wa-phone-name">{BRAND.name}</span>
          <span className="wa-phone-sub">{isLive ? "an example" : "demo, answering from these books"}</span>
        </div>
        <div className="wa-phone-chat" aria-live="polite">
          {chat.map((b, i) => (
            <p key={i} className={`wa-bubble wa-${b.from}`}>
              {b.voice ? <span className="wa-voice" aria-label="Voice note">▶ voice note · </span> : null}
              <Linked text={b.text} />
            </p>
          ))}
          {busy ? <p className="wa-bubble wa-office wa-typing">typing…</p> : null}
          <div ref={end} />
        </div>
        {isLive ? null : (
          <form
            className="wa-phone-input"
            onSubmit={(e) => {
              e.preventDefault();
              const t = text.trim();
              if (!t || busy) return;
              setText("");
              void send({ text: t }, { from: "you", text: t });
            }}
          >
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message" aria-label="Message to the office" />
            <button type="submit" className="btn btn-primary btn-small" disabled={busy || !text.trim()}>
              Send
            </button>
          </form>
        )}
      </div>
      <div className="wa-demo-side">
        {isLive ? (
          <p>
            Link your own phone in <Link to="/settings" hash="whatsapp">Settings, under Your WhatsApp</Link>. Then send desk, answer by number, ask questions, forward photos of bills, or send a voice note in your own language. Nothing you send is posted on its own; it waits on your desk.
          </p>
        ) : (
          <>
            <p>Try: desk, then 1 yes or 2 later. Or ask "who owes me the most?". Hindi and Marathi work too: 1 haan, 2 nahi, 3 baad mein.</p>
            <p className="wa-voice-label">Voice notes, with what the office heard:</p>
            <div className="wa-voice-list">
              {SAMPLE_VOICE.map((v) => (
                <button key={v.id} type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => void send({ voice: v.id }, { from: "you", text: v.transcript, voice: true })}>
                  {v.label}
                </button>
              ))}
            </div>
            <p className="field-help">On this demo, item titles and answers stay in English; the live office translates them and keeps every figure as it is.</p>
          </>
        )}
      </div>
    </div>
  );
}
