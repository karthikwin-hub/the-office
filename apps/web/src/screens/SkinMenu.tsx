import { SkinId } from "@office/contracts";
import { SKINS } from "@office/ui";
import { useChosenSkin, usePrefs } from "../app/prefs";

/** A quiet way to change the look of the office from the floor. Settings has the full picker. */
export function SkinMenu() {
  const chosen = useChosenSkin();
  const [, setPrefs] = usePrefs();
  return (
    <label className="skin-menu">
      <span>Skin</span>
      <select
        value={chosen}
        onChange={(e) => {
          const next = SkinId.safeParse(e.target.value);
          if (next.success) setPrefs({ skin: next.data });
        }}
      >
        {SKINS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}
