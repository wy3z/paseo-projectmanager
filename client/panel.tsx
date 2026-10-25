import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { openPath, projectIdentity, projectPrs, projectStatus, readContextFile } from "../shared/contracts";
import { ContextView } from "./context-view";
import { FocusCard, type LinkContext, MarkdownBlocks } from "./markdown";
import { parseMarkdown } from "./notes-format";
import { makeStyles } from "./styles";
import { ReviewView } from "./review-view";
import { openFileInWorkspace } from "./web";
import { PR_POLL_MS } from "./prs-tray";

const POLL_MS = 5000;

type Tab = "notes" | "context";

export function ProjectPanel({ theme, layout, host, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const toast = useToast();
  const getStatus = useRpc(projectStatus);
  const readFile = useRpc(readContextFile);
  const getPrs = useRpc(projectPrs);
  const resolvePath = useRpc(openPath);
  const getIdentity = useRpc(projectIdentity);
  const project = useWorkspace(workspaceId, (workspace) => ({
    id: workspace.projectId,
    name: workspace.projectDisplayName,
  }));
  const identity = useQuery({
    queryKey: ["identity", project?.id],
    queryFn: () => getIdentity({ projectId: project!.id }),
    enabled: !!project,
    staleTime: 5 * 60_000,
  });
  const [tab, setTab] = useState<Tab>("notes");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [reviewAgent, setReviewAgent] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["status", workspaceId],
    queryFn: () => getStatus({ workspaceId }),
    refetchInterval: POLL_MS,
  });
  const state = status.data?.state ?? null;
  const notes = useQuery({
    queryKey: ["file", workspaceId, "notes.md", "current"],
    queryFn: () => readFile({ workspaceId, path: "notes.md" }),
    refetchInterval: POLL_MS,
    enabled: state !== null,
  });
  const prs = useQuery({
    queryKey: ["prs", workspaceId],
    queryFn: () => getPrs({ workspaceId }),
    refetchInterval: PR_POLL_MS,
    enabled: state !== null,
  });

  const prList = prs.data?.prs ?? [];
  const ctx: LinkContext = {
    styles,
    theme,
    contextDir: state?.contextDir ?? "",
    prs: new Map(prList.map((pr) => [pr.url, pr])),
    openAgent: navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined,
    review: tab === "notes" ? { workspaceId, open: setReviewAgent } : undefined,
    openFile: (path) => {
      // Open as a tab in the main workspace; phones have no file tabs, so they use the panel's viewer.
      if (!state || !openFileInWorkspace({ serverId: host.id, workspaceId, path: `${state.contextDir}/${path}` })) {
        setSelectedFile(path);
        setTab("context");
      }
    },
    openPath: (path) => {
      resolvePath({ path, openFolders: layout.platform === "web" })
        .then((result) => {
          if (result.kind !== "file") return;
          if (openFileInWorkspace({ serverId: host.id, workspaceId, path: result.absolutePath })) return;
          const contextDir = state?.contextDir;
          if (contextDir && result.absolutePath.startsWith(`${contextDir}/`)) {
            setSelectedFile(result.absolutePath.slice(contextDir.length + 1));
            setTab("context");
          } else {
            toast.show("Files outside the Project store open from the desktop app.");
          }
        })
        .catch((error: Error) => toast.error(error.message));
    },
  };

  if (status.isPending) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }
  if (status.isError) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.danger}>{status.error.message}</Text>
      </View>
    );
  }
  if (!state) {
    return (
      <View style={[styles.screen, styles.content]}>
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No Project Yet</Text>
          <Text style={[styles.muted, { textAlign: "center" }]}>
            Run /projectmanager in a chat to make it this workspace's coordinator. It keeps its
            conversation, tracks the work in notes.md, and briefs the agents it starts.
          </Text>
        </View>
      </View>
    );
  }

  const parsed = notes.data?.content ? parseMarkdown(notes.data.content) : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.tabBar}>
        {identity.data?.icon && (
          <Image
            accessibilityIgnoresInvertColors
            source={{ uri: `data:${identity.data.icon.mimeType};base64,${identity.data.icon.data}` }}
            style={styles.projectIcon}
          />
        )}
        <Text style={styles.projectName} numberOfLines={1}>
          {identity.data?.name ?? project?.name ?? "Project"}
        </Text>
        {!state.enabled && <Text style={styles.muted}>· off</Text>}
        <View style={styles.tabs}>
        <TabButton label="Notes" active={tab === "notes"} onPress={() => { setTab("notes"); setReviewAgent(null); }} styles={styles} />
        <TabButton
          label="Context"
          active={tab === "context"}
          onPress={() => {
            setTab("context");
            setSelectedFile(null);
            setReviewAgent(null);
          }}
          styles={styles}
        />
        </View>
      </View>

      {tab === "notes" && reviewAgent ? (
        <ReviewView
          key={reviewAgent}
          workspaceId={workspaceId}
          agentId={reviewAgent}
          theme={theme}
          styles={styles}
          compact={layout.compact}
          onBack={() => setReviewAgent(null)}
        />
      ) : tab === "notes" ? (
        parsed && (parsed.focus || parsed.blocks.length) ? (
          <View style={{ gap: 12 }}>
            {parsed.focus && <FocusCard text={parsed.focus} ctx={ctx} />}
            <MarkdownBlocks blocks={parsed.blocks} ctx={ctx} />
          </View>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No work tracked yet</Text>
            <Text style={styles.muted}>Ask the coordinator for something and it shows up here.</Text>
          </View>
        )
      ) : (
        <ContextView
          workspaceId={workspaceId}
          files={status.data.files}
          selected={selectedFile}
          onSelect={setSelectedFile}
          ctx={ctx}
        />
      )}
    </ScrollView>
  );
}

function TabButton({ label, active, onPress, styles }: {
  label: string;
  active: boolean;
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={styles.tab(active)}
    >
      <Text style={styles.tabText(active)}>{label}</Text>
    </Pressable>
  );
}
