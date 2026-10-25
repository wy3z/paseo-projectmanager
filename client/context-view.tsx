import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type HistoryEntry, contextHistory, readContextFile, restoreContext } from "../shared/contracts";
import { type LinkContext, MarkdownBlocks } from "./markdown";
import { parseMarkdown } from "./notes-format";

const POLL_MS = 5000;
const RECENTS = 7;

interface ContextFile {
  path: string;
  size: number;
  modifiedAt: string;
}

/** Agent-only folders, shown dimmed and left out of Recents. */
function isAgentOnly(path: string) {
  return path.startsWith("internal/") || path.startsWith("inbox/");
}

export function ContextView({ workspaceId, files, selected, onSelect, ctx }: {
  workspaceId: string;
  files: readonly ContextFile[];
  selected: string | null;
  onSelect(path: string | null): void;
  ctx: LinkContext;
}) {
  const { styles } = ctx;
  const [version, setVersion] = useState<HistoryEntry | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  if (!files.length) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>The store is empty</Text>
        <Text style={styles.muted}>Files the coordinator and workers write show up here.</Text>
      </View>
    );
  }

  if (selected) {
    return (
      <View style={{ gap: 10 }}>
        <View style={styles.headerRow}>
          <Pressable accessibilityRole="button" onPress={() => { onSelect(null); setVersion(null); }}>
            <Text style={[styles.muted, styles.link]}>‹ All files</Text>
          </Pressable>
          <Text style={styles.path}>{selected}</Text>
        </View>
        {version && (
          <View style={[styles.card, styles.headerRow]}>
            <Text style={[styles.muted, styles.flexText]}>
              Viewing the version from {formatTime(version.at)}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => setVersion(null)}>
              <Text style={[styles.muted, styles.link]}>Back to current</Text>
            </Pressable>
          </View>
        )}
        <FileView workspaceId={workspaceId} path={selected} commit={version?.commit} ctx={ctx} />
      </View>
    );
  }

  const recents = [...files]
    .filter((file) => file.path !== "notes.md" && !isAgentOnly(file.path))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, RECENTS);

  return (
    <View style={{ gap: 16 }}>
      {recents.length > 0 && (
        <View style={{ gap: 4 }}>
          <Text style={styles.sectionLabel}>Recents</Text>
          {recents.map((file) => (
            <FileRow key={file.path} file={file} label={file.path} onPress={() => ctx.openFile(file.path)} ctx={ctx} />
          ))}
        </View>
      )}
      <View style={{ gap: 4 }}>
        <Text style={styles.sectionLabel}>All Files</Text>
        {files.map((file) => {
          const depth = file.path.split("/").length - 1;
          return (
            <View key={file.path} style={[{ paddingLeft: depth * 14 }, isAgentOnly(file.path) && styles.dim]}>
              <FileRow file={file} label={file.path} onPress={() => ctx.openFile(file.path)} ctx={ctx} />
            </View>
          );
        })}
      </View>
      <View style={{ gap: 6 }}>
        <Pressable accessibilityRole="button" onPress={() => setShowHistory((value) => !value)}>
          <Text style={styles.sectionLabel}>{showHistory ? "▾" : "▸"} History</Text>
        </Pressable>
        {showHistory && (
          <History
            workspaceId={workspaceId}
            ctx={ctx}
            onView={(entry, path) => {
              setVersion(entry);
              onSelect(path);
            }}
          />
        )}
      </View>
    </View>
  );
}

function FileRow({ file, label, onPress, ctx }: {
  file: ContextFile;
  label: string;
  onPress(): void;
  ctx: LinkContext;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${label}`} onPress={onPress} style={ctx.styles.entryRow}>
      <Text style={[ctx.styles.text, ctx.styles.flexText]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={ctx.styles.muted}>{formatTime(file.modifiedAt)}</Text>
    </Pressable>
  );
}

export function FileView({ workspaceId, path, commit, ctx }: {
  workspaceId: string;
  path: string;
  commit?: string;
  ctx: LinkContext;
}) {
  const read = useRpc(readContextFile);
  const file = useQuery({
    queryKey: ["file", workspaceId, path, commit ?? "current"],
    queryFn: () => read({ workspaceId, path, commit }),
    refetchInterval: commit ? false : POLL_MS,
  });
  const { styles } = ctx;
  if (file.isPending) return <Text style={styles.muted}>Loading…</Text>;
  if (file.isError) return <Text style={styles.danger}>{file.error.message}</Text>;
  const content = file.data.content;
  if (content === null) {
    return <Text style={styles.muted}>{commit ? "This file did not exist in that version." : "Not written yet."}</Text>;
  }
  if (!path.endsWith(".md")) {
    return (
      <View style={styles.codeBlock}>
        <Text selectable style={styles.code}>
          {content}
        </Text>
      </View>
    );
  }
  const parsed = parseMarkdown(content);
  return (
    <View style={{ gap: 8 }}>
      {parsed.description && <Text style={styles.muted}>{parsed.description}</Text>}
      {parsed.focus && <Text style={styles.text}>{parsed.focus}</Text>}
      <MarkdownBlocks blocks={parsed.blocks} ctx={ctx} />
    </View>
  );
}

function History({ workspaceId, ctx, onView }: {
  workspaceId: string;
  ctx: LinkContext;
  onView(entry: HistoryEntry, path: string): void;
}) {
  const { styles } = ctx;
  const getHistory = useRpc(contextHistory);
  const restore = useRpc(restoreContext);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState<string | null>(null);
  const history = useQuery({
    queryKey: ["history", workspaceId],
    queryFn: () => getHistory({ workspaceId, limit: 100 }),
    refetchInterval: POLL_MS,
  });
  const restoreMutation = useMutation({
    mutationFn: (commit: string) => restore({ workspaceId, commit }),
    onSuccess: () => {
      setConfirming(null);
      toast.show("Restored. The previous state is kept in history.", { variant: "success" });
      void queryClient.invalidateQueries();
    },
    onError: (error) => toast.show(error.message, { variant: "error" }),
  });

  if (history.isPending) return <Text style={styles.muted}>Loading…</Text>;
  if (history.isError) return <Text style={styles.danger}>{history.error.message}</Text>;
  if (!history.data.entries.length) return <Text style={styles.muted}>No history yet.</Text>;

  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.muted}>
        The store is snapshotted after every agent turn. Restoring adds a new snapshot, so it can be undone here too.
      </Text>
      {history.data.entries.map((entry, index) => {
        const files = entry.files.filter((file) => !file.startsWith(".projectmanager/"));
        return (
          <View key={entry.commit} style={styles.card}>
            <Text style={styles.text}>{entry.message || "Snapshot"}</Text>
            <Text style={styles.muted}>
              {formatTime(entry.at)}
              {files.length ? ` · ${files.join(", ")}` : ""}
            </Text>
            <View style={styles.row}>
              {files[0] && (
                <Pressable accessibilityRole="button" onPress={() => onView(entry, files[0])}>
                  <Text style={[styles.muted, styles.link]}>View</Text>
                </Pressable>
              )}
              {index > 0 && (
                <Pressable
                  accessibilityRole="button"
                  disabled={restoreMutation.isPending}
                  onPress={() =>
                    confirming === entry.commit ? restoreMutation.mutate(entry.commit) : setConfirming(entry.commit)
                  }
                >
                  <Text style={confirming === entry.commit ? styles.danger : [styles.muted, styles.link]}>
                    {confirming === entry.commit ? "Confirm restore" : "Restore this version"}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function formatTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
