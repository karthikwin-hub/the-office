import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { account, isLive } from "../api/client";
import { q } from "../api/queries";
import { Section, shortDate } from "./common";

/** Each person's own account, whatever office they are in: a copy of what we hold about them, and deleting it. */
export function AccountSettings() {
  const qc = useQueryClient();
  const me = useQuery({ ...q.me(), enabled: isLive });
  const requests = useQuery({ queryKey: ["me", "requests"], queryFn: account.requests, enabled: isLive });
  const [confirming, setConfirming] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["me"] });
  const download = useMutation({ mutationFn: account.exportMine });
  // The account is gone, and with it this session: back to the sign-in page.
  const remove = useMutation({ mutationFn: () => account.deleteAccount(), onSuccess: () => location.assign("/") });
  const withdraw = useMutation({ mutationFn: (id: string) => account.withdrawRequest(id), onSuccess: refresh });
  if (!isLive) return null;
  const open = requests.data?.requests.find((r) => r.kind === "delete" && r.status === "open");
  return (
    <Section title="Your account">
      <p className="section-lede">
        This is about you, {me.data?.user.email ?? "your account"}, not the business. The business's books belong to it; an owner exports them under Office. See
        the <a href="/legal/privacy">privacy notice</a> for what we keep and why.
      </p>
      <div className="approval-actions">
        <button type="button" className="btn" onClick={() => download.mutate()} disabled={download.isPending}>
          Download my data
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => setConfirming(true)} disabled={confirming}>
          Delete my account
        </button>
      </div>
      {download.error ? <p className="form-error">{download.error.message}</p> : null}
      {confirming ? (
        <div className="promotion" role="alertdialog" aria-label="Delete my account">
          <p>
            <strong>Delete your account now?</strong> You leave every office you are in and can no longer sign in; this cannot be undone. An office only you are
            in is deleted with it, and nobody can restore it. If you are the only owner of an office others work in, make one of them an owner first. Your name
            stays in the books where you approved or recorded something, because the business must keep those records.
          </p>
          <div className="approval-actions">
            <button type="button" className="btn btn-primary" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Delete my account
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
          {remove.error ? <p className="form-error">{remove.error.message}</p> : null}
        </div>
      ) : null}
      {open ? (
        <p role="status">
          You asked on {shortDate(open.createdAt)} for your account to be deleted. We will do it within 30 days of that, or you can delete it now above.{" "}
          <button type="button" className="link-button" onClick={() => withdraw.mutate(open.id)} disabled={withdraw.isPending}>
            Withdraw the request
          </button>
        </p>
      ) : null}
    </Section>
  );
}
