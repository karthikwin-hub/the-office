import { DEFAULT_PREFS, Prefs, SkinId } from "@office/contracts";
import { applySkin, DEFAULT_SKIN, SKIN_BY_ID, type Skin } from "@office/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";

/** The last preferences seen on this machine; also read by the inline script in index.html before React starts. */
export const PREFS_CACHE = "office.prefs";

export function cachedPrefs(): Prefs {
  try {
    return Prefs.parse({ ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_CACHE) ?? "{}") });
  } catch {
    return DEFAULT_PREFS;
  }
}

/** `?skin=loft` previews a skin for this tab without saving it; for demos and screenshots. */
export function skinFromUrl(): SkinId | null {
  const fromUrl = new URLSearchParams(location.search).get("skin");
  if (fromUrl) sessionStorage.setItem("office.skin", fromUrl);
  const s = SkinId.safeParse(fromUrl ?? sessionStorage.getItem("office.skin"));
  return s.success ? s.data : null;
}

/** Phones and small tablets: people there want to get something done fast, so the Lived-in office stays plain. */
export const PHONE = "(max-width: 767px), (pointer: coarse) and (max-width: 1023px)";
export function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}
export const usePhone = () => useMedia(PHONE);

/** The skin worn before the Lived-in office, which a phone shows instead of it. */
const BEFORE_LIVED_IN = "office.skin.before-lived-in";
function skinBeforeLivedIn(): Skin {
  try {
    const s = SkinId.safeParse(localStorage.getItem(BEFORE_LIVED_IN));
    return s.success && s.data !== "lived-in" ? (SKIN_BY_ID[s.data] ?? DEFAULT_SKIN) : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

/** The skin the person chose (or is previewing), whatever the screen. */
export function useChosenSkin(): SkinId {
  const [prefs] = usePrefs();
  return skinFromUrl() ?? prefs.skin;
}

/** The skin on screen now: a `?skin=` preview if there is one, otherwise the person's own; on a phone the Lived-in office wears the skin from before it. */
export function useSkin(): Skin {
  const chosen = useChosenSkin();
  const phone = usePhone();
  if (chosen === "lived-in" && phone) return skinBeforeLivedIn();
  return SKIN_BY_ID[chosen] ?? DEFAULT_SKIN;
}

/** "Use the simpler picture": the drawn Lived-in floor instead of the 3D one, remembered by this browser only. */
const SIMPLE_PICTURE = "office.lived-in.simple";
const readSimple = () => {
  try {
    return localStorage.getItem(SIMPLE_PICTURE) === "1";
  } catch {
    return false;
  }
};
export function useSimplePicture(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readSimple);
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === SIMPLE_PICTURE) setOn(readSimple());
    };
    addEventListener("storage", sync);
    return () => removeEventListener("storage", sync);
  }, []);
  const set = (v: boolean) => {
    try {
      if (v) localStorage.setItem(SIMPLE_PICTURE, "1");
      else localStorage.removeItem(SIMPLE_PICTURE);
    } catch {
      /* a private window may refuse; the choice then lasts this visit */
    }
    setOn(v);
  };
  return [on, set];
}

/** Keeps the page dressed in the current skin. Called once, by the shell. */
export function useApplySkin() {
  const skin = useSkin();
  useEffect(() => applySkin(skin), [skin]);
}

/** The signed-in person's preferences, shown at once from this machine's copy and then synced with the office. */
export function usePrefs(): [Prefs, (change: Partial<Prefs>) => void] {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["prefs"], queryFn: api.prefs, placeholderData: cachedPrefs, staleTime: 5 * 60_000 });
  const prefs = query.data ?? cachedPrefs();
  useEffect(() => {
    if (query.data) localStorage.setItem(PREFS_CACHE, JSON.stringify(query.data));
  }, [query.data]);
  const save = useMutation({
    mutationFn: (change: Partial<Prefs>) => api.savePrefs(change),
    onMutate: (change) => {
      if (change.skin) sessionStorage.removeItem("office.skin");
      const was = qc.getQueryData<Prefs>(["prefs"])?.skin ?? cachedPrefs().skin;
      if (change.skin === "lived-in" && was !== "lived-in") {
        try {
          localStorage.setItem(BEFORE_LIVED_IN, was);
        } catch {
          /* without storage a phone falls back to the default skin */
        }
      }
      qc.setQueryData<Prefs>(["prefs"], (old) => ({ ...(old ?? cachedPrefs()), ...change }));
    },
    onSuccess: (saved) => qc.setQueryData(["prefs"], saved),
  });
  return [prefs, save.mutate];
}
