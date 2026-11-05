import { DEFAULT_PREFS, Prefs, SkinId } from "@office/contracts";
import { applySkin, DEFAULT_SKIN, SKIN_BY_ID, type Skin } from "@office/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
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

/** The skin on screen now: a `?skin=` preview if there is one, otherwise the person's own. */
export function useSkin(): Skin {
  const [prefs] = usePrefs();
  return SKIN_BY_ID[skinFromUrl() ?? prefs.skin] ?? DEFAULT_SKIN;
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
      qc.setQueryData<Prefs>(["prefs"], (old) => ({ ...(old ?? cachedPrefs()), ...change }));
    },
    onSuccess: (saved) => qc.setQueryData(["prefs"], saved),
  });
  return [prefs, save.mutate];
}
