import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type WorkerFile, workerChanges, workerDiff } from "../shared/contracts";
import type { Styles, Theme } from "./styles";

const STALE_MS = 30_000;

function useWorkerChanges(workspaceId: string, agentId: string) {
  const getChanges = useRpc(workerChanges);
  return useQuery({
    queryKey: ["worker-changes", workspaceId, agentId],
    queryFn: () => getChanges({ workspaceId, agentId }),
    staleTime: STALE_MS,
    refetchInterval: STALE_MS,
    retry: false,
  });
}

function Counts({ additions, deletions, theme }: { additions: number; deletions: number; theme: Theme }) {
  return (
    <>
      <Text style={{ color: theme.colors.statusSuccess }}>+{additions}</Text>
      {" "}
      <Text style={{ color: theme.colors.statusDanger }}>−{deletions}</Text>
    </>
  );
}

export function WorkerReviewChip({ workspaceId, agentId, theme, onPress }: {
  workspaceId: string;
  agentId: string;
  theme: Theme;
  onPress(): void;
}) {
  const changes = useWorkerChanges(workspaceId, agentId);
  if (changes.isError || !changes.data?.files.length) return null;
  const additions = changes.data.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = changes.data.files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review changes: ${additions} additions, ${deletions} deletions`}
      onPress={onPress}
      style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: theme.colors.surface2 }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Review <Counts additions={additions} deletions={deletions} theme={theme} />
      </Text>
    </Pressable>
  );
}

export function ReviewView({ workspaceId, agentId, theme, styles, compact, onBack }: {
  workspaceId: string;
  agentId: string;
  theme: Theme;
  styles: Styles;
  compact: boolean;
  onBack(): void;
}) {
  const title = useAgent(agentId, (agent) => agent.title);
  const changes = useWorkerChanges(workspaceId, agentId);
  return (
    <View style={{ gap: compact ? 8 : 12 }}>
      <View style={styles.headerRow}>
        <Pressable accessibilityRole="button" onPress={onBack} style={{ paddingVertical: 4 }}>
          <Text style={[styles.muted, styles.link]}>‹ Notes</Text>
        </Pressable>
        <Text style={[styles.text, { flexShrink: 1 }]}>{title || agentId.slice(0, 8)}</Text>
        {changes.data?.base && <Text style={styles.path}>Base {changes.data.base.slice(0, 8)}</Text>}
      </View>
      {changes.isPending ? <Text style={styles.muted}>Loading changes…</Text> : changes.isError ? (
        <Text style={styles.danger}>{changes.error.message}</Text>
      ) : !changes.data.files.length ? (
        <Text style={styles.muted}>{changes.data.base ? "No changed files." : "No changes to review against a default branch."}</Text>
      ) : (
        changes.data.files.map((file) => (
          <ReviewFile
            key={file.path}
            file={file}
            workspaceId={workspaceId}
            agentId={agentId}
            base={changes.data.base}
            theme={theme}
            styles={styles}
            compact={compact}
          />
        ))
      )}
    </View>
  );
}

function ReviewFile({ file, workspaceId, agentId, base, theme, styles, compact }: {
  file: WorkerFile;
  workspaceId: string;
  agentId: string;
  base: string | null;
  theme: Theme;
  styles: Styles;
  compact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const getDiff = useRpc(workerDiff);
  const diff = useQuery({
    queryKey: ["worker-diff", workspaceId, agentId, file.path, base],
    queryFn: () => getDiff({ workspaceId, agentId, path: file.path }),
    enabled: expanded,
    staleTime: STALE_MS,
    refetchInterval: expanded ? STALE_MS : false,
    retry: false,
  });
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${file.path}, ${file.status}, ${file.additions} additions, ${file.deletions} deletions`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={[styles.entryRow, { flexWrap: "wrap", paddingVertical: compact ? 8 : 6 }]}
      >
        <Text style={styles.muted}>{expanded ? "▾" : "▸"}</Text>
        <Text style={[styles.code, { flex: 1, minWidth: 0 }]}>{file.path}</Text>
        <Text style={styles.muted}>{file.status}</Text>
        <Text style={styles.muted}><Counts additions={file.additions} deletions={file.deletions} theme={theme} /></Text>
      </Pressable>
      {expanded && (diff.isPending ? <Text style={styles.muted}>Loading diff…</Text> : diff.isError ? (
        <Text style={styles.danger}>{diff.error.message}</Text>
      ) : (
        <View style={{ gap: 6 }}>
          <ScrollView horizontal style={{ backgroundColor: theme.colors.surface2 }}>
            <View style={{ padding: compact ? 6 : 10 }}>
              {diff.data.diff ? diff.data.diff.split("\n").map((line, index) => (
                <Text key={index} selectable style={[styles.code, {
                  color: line.startsWith("+") ? theme.colors.statusSuccess
                    : line.startsWith("-") ? theme.colors.statusDanger
                    : line.startsWith("@@") ? theme.colors.foregroundMuted : theme.colors.foreground,
                }]}>{line || " "}</Text>
              )) : <Text style={styles.muted}>No diff available.</Text>}
            </View>
          </ScrollView>
          {diff.data.truncated && <Text style={styles.muted}>Diff limited to 200 KB.</Text>}
        </View>
      ))}
    </View>
  );
}
