import { AGENT_BY_ID, type PersonaNames } from "@office/contracts";
import { PERSONAS } from "@office/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { q } from "../api/queries";
import { isOwner } from "./common";

/** The names the team goes by in the Lived-in office. The owner chooses them for everyone; the work is the same whatever they are called. */
export function PersonaNamesForm() {
  const qc = useQueryClient();
  const owner = isOwner();
  const office = useQuery(q.office());
  const ambient = useQuery(q.ambient());
  const [draft, setDraft] = useState<PersonaNames>({});
  useEffect(() => setDraft(ambient.data?.names ?? {}), [ambient.data]);
  const save = useMutation({
    mutationFn: (names: PersonaNames) => api.savePersonaNames(names),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ambient"] }),
  });
  const hired = (office.data?.rooms ?? []).filter((r) => r.hired && PERSONAS[r.agentId]).map((r) => r.agentId);
  if (!hired.length) return null;
  const cleaned = (d: PersonaNames): PersonaNames =>
    Object.fromEntries(
      Object.entries(d)
        .map(([k, v]) => [k, v.trim()] as const)
        .filter(([k, v]) => v && v !== PERSONAS[k]?.name),
    );

  return (
    <div className="persona-names">
      <h3 className="h3">Names in the Lived-in office</h3>
      <p className="field-help">
        {owner ? "What the team is called on the floor and in its log, for everyone in this office. Leave a name empty to use the one shown." : "The owner chooses what the team is called on the floor."}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(cleaned(draft));
        }}
      >
        <dl className="persona-list">
          {hired.map((id) => (
            <div key={id} className="persona-row">
              <dt>
                <label htmlFor={`persona-${id}`}>{AGENT_BY_ID[id]!.short}</label>
              </dt>
              <dd>
                {owner ? (
                  <input id={`persona-${id}`} type="text" maxLength={24} placeholder={PERSONAS[id]!.name} value={draft[id] ?? ""} onChange={(e) => setDraft({ ...draft, [id]: e.target.value })} />
                ) : (
                  <span id={`persona-${id}`}>{ambient.data?.names[id] ?? PERSONAS[id]!.name}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {owner ? (
          <div className="approval-actions">
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              Save the names
            </button>
            <button type="button" className="btn btn-quiet" disabled={save.isPending} onClick={() => (setDraft({}), save.mutate({}))}>
              Use the usual names
            </button>
          </div>
        ) : null}
        {save.error ? <p className="form-error">{save.error.message}</p> : save.isSuccess ? <p role="status" className="muted">Saved.</p> : null}
      </form>
    </div>
  );
}
