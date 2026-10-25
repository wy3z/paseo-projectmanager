import { type PluginButtonContentProps, openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type PullRequest, projectPrs } from "../shared/contracts";
import { PR_ICONS, prColor } from "./markdown";
import { makeStyles } from "./styles";

// The PRs tray in the composer: open PRs grouped by what they need,
// done PRs collapsed under a divider.

export const PR_POLL_MS = 60_000;

const OPEN_GROUPS: readonly PullRequest["group"][] = [
  "Merge conflicts",
  "Checks failing",
  "Changes requested",
  "Approved",
  "Awaiting review",
  "Draft",
];
const DONE_GROUPS: readonly PullRequest["group"][] = ["Merged", "Closed"];

export function isOpenPr(pr: PullRequest) {
  return pr.state === "open" || pr.state === "draft";
}

export function PrsTray({ theme, layout, workspaceId }: PluginButtonContentProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const getPrs = useRpc(projectPrs);
  const [showDone, setShowDone] = useState(false);
  const prs = useQuery({
    queryKey: ["prs", workspaceId],
    queryFn: () => getPrs({ workspaceId }),
    refetchInterval: PR_POLL_MS,
  });

  if (prs.isPending) return <Text style={styles.muted}>Looking up pull requests…</Text>;
  if (prs.isError) return <Text style={styles.danger}>{prs.error.message}</Text>;
  const list = prs.data.prs;
  if (!list.length) return <Text style={styles.muted}>No PRs linked yet.</Text>;

  const open = list.filter(isOpenPr);
  const done = list.filter((pr) => !isOpenPr(pr));
  const group = (groups: readonly PullRequest["group"][]) =>
    groups.map((name) => {
      const items = list.filter((pr) => pr.group === name);
      if (!items.length) return null;
      return (
        <View key={name}>
          <Text style={styles.sectionLabel}>{name}</Text>
          {items.map((pr) => (
            <Pressable
              key={pr.url}
              accessibilityRole="link"
              accessibilityLabel={`Open pull request ${pr.number}`}
              onPress={() => void openExternalUrl(pr.url)}
              style={styles.entryRow}
            >
              <Icon name={PR_ICONS[pr.state]} size={15} color={prColor(theme, pr)} />
              <Text style={[styles.text, styles.flexText]} numberOfLines={1}>
                #{pr.number} {pr.title}
              </Text>
              <Text style={styles.path} numberOfLines={1}>
                {pr.branch}
              </Text>
            </Pressable>
          ))}
        </View>
      );
    });

  return (
    <View style={{ gap: 8, minWidth: layout.compact ? undefined : 380 }}>
      <Text style={styles.title}>{open.length ? `${open.length} Open` : `${done.length} Done`}</Text>
      {group(OPEN_GROUPS)}
      {done.length > 0 && open.length > 0 && (
        <Pressable accessibilityRole="button" onPress={() => setShowDone((value) => !value)}>
          <Text style={styles.sectionLabel}>
            {showDone ? "▾" : "▸"} Done ({done.length})
          </Text>
        </Pressable>
      )}
      {(showDone || !open.length) && group(DONE_GROUPS)}
    </View>
  );
}
