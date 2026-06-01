import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppSettings, SourceImage } from "../types";
import {
  deleteSource as deletePersistedSource,
  loadPersistedState,
  saveSettings,
  saveSource,
  saveSourceJson,
} from "./persistence";

export type SessionState = {
  settings: AppSettings;
  sources: SourceImage[];
};

export const initialSettings: AppSettings = {
  minCropAreaPercent: 4,
  jpegQuality: 92,
};

const sessionQueryKey = ["session"] as const;

const emptySession: SessionState = {
  settings: initialSettings,
  sources: [],
};

function getSession(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.getQueryData<SessionState>(sessionQueryKey) ?? emptySession;
}

export function usePersistedSession(onPersistenceError: (error: unknown, fallbackMessage: string) => void) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<SessionState> => {
      const persisted = await loadPersistedState();
      return {
        settings: persisted.settings ?? initialSettings,
        sources: persisted.sources,
      };
    },
  });

  const settingsMutation = useMutation({
    mutationFn: saveSettings,
    onError: (error) => onPersistenceError(error, "Could not save settings."),
  });

  const sourceJsonMutation = useMutation({
    mutationFn: saveSourceJson,
    onError: (error, source) => onPersistenceError(error, `Could not save ${source.fileName}.`),
  });

  const addSourcesMutation = useMutation({
    mutationFn: async (sources: SourceImage[]) => {
      await Promise.all(sources.map(saveSource));
    },
    onError: (error) => onPersistenceError(error, "Could not save uploaded images."),
  });

  const deleteSourceMutation = useMutation({
    mutationFn: deletePersistedSource,
    onError: (error) => onPersistenceError(error, "Could not remove saved source."),
  });

  const updateSettings = useCallback(
    (updater: AppSettings | ((settings: AppSettings) => AppSettings)) => {
      const current = getSession(queryClient);
      const settings = typeof updater === "function" ? updater(current.settings) : updater;
      queryClient.setQueryData<SessionState>(sessionQueryKey, { ...current, settings });
      settingsMutation.mutate(settings);
    },
    [queryClient, settingsMutation],
  );

  const addSources = useCallback(
    async (sources: SourceImage[]) => {
      if (sources.length === 0) return;
      const current = getSession(queryClient);
      queryClient.setQueryData<SessionState>(sessionQueryKey, { ...current, sources: [...current.sources, ...sources] });
      await addSourcesMutation.mutateAsync(sources);
    },
    [addSourcesMutation, queryClient],
  );

  const updateSource = useCallback(
    (sourceId: string, updater: (source: SourceImage) => SourceImage) => {
      let nextSource: SourceImage | undefined;
      const current = getSession(queryClient);
      const sources = current.sources.map((source) => {
        if (source.id !== sourceId) return source;
        nextSource = updater(source);
        return nextSource;
      });
      queryClient.setQueryData<SessionState>(sessionQueryKey, { ...current, sources });
      if (nextSource) sourceJsonMutation.mutate(nextSource);
    },
    [queryClient, sourceJsonMutation],
  );

  const removeSource = useCallback(
    (sourceId: string) => {
      const current = getSession(queryClient);
      const sources = current.sources.filter((source) => source.id !== sourceId);
      queryClient.setQueryData<SessionState>(sessionQueryKey, { ...current, sources });
      deleteSourceMutation.mutate(sourceId);
    },
    [deleteSourceMutation, queryClient],
  );

  return {
    session: sessionQuery.data ?? emptySession,
    isLoading: sessionQuery.isLoading,
    isUploadingSources: addSourcesMutation.isPending,
    loadError: sessionQuery.error,
    updateSettings,
    addSources,
    updateSource,
    removeSource,
  };
}
