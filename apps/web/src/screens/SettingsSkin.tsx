import { SkinPreview, SKINS } from "@office/ui";
import { usePrefs, useSkin } from "../app/prefs";
import { PersonaNamesForm } from "./SettingsPersonas";

/** Each person dresses the office their own way; the choice follows them to any machine they sign in on. */
export function SkinPicker() {
  const skin = useSkin();
  const [prefs, setPrefs] = usePrefs();
  return (
    <fieldset className="skin-picker">
      <legend className="h2">Your office</legend>
      <p className="field-help skin-picker-help">How the office looks to you. Only you see your choice, on any computer you sign in on; the work and the figures stay the same.</p>
      <div className="skin-options">
        {SKINS.map((s) => (
          <label key={s.id} className={`skin-option${skin.id === s.id ? " is-current" : ""}`}>
            <input type="radio" name="skin" value={s.id} checked={skin.id === s.id} onChange={() => setPrefs({ skin: s.id })} className="visually-hidden" />
            <SkinPreview skin={s} />
            <span className="skin-option-name">{s.name}</span>
            <span className="skin-option-text">{s.description}</span>
          </label>
        ))}
      </div>
      <label className="skin-whole-floor">
        <input type="checkbox" checked={prefs.wholeFloor} onChange={(e) => setPrefs({ wholeFloor: e.target.checked })} /> Show every room on the floor, including vacant ones
      </label>
      {skin.id === "lived-in" ? (
        <>
          <p className="field-help">
            In the Lived-in office the team says what it is doing in the words of its log, and now and then has a word over tea about the weather, a festival or a birthday. To mention the weather we ask MET Norway (api.met.no) for the forecast near you, sending only an area about ten kilometres across. Weather data: MET Norway, under CC BY 4.0.
          </p>
          <PersonaNamesForm />
        </>
      ) : null}
    </fieldset>
  );
}
