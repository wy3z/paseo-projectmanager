import { type PluginButtonContentProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { projectPrs, setPrFollowed } from "../shared/contracts";
import { PR_ICONS, prColor } from "./markdown";
import { PR_POLL_MS } from "./prs-tray";
import { makeStyles } from "./styles";

// The "Following" pill: what the coordinator is subscribed to, with a way to unfollow.

export function FollowingTray({ theme, layout, workspaceId }: PluginButtonContentProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const getPrs = useRpc(projectPrs);
  const setFollowed = useRpc(setPrFollowed);
  const queryClient = useQueryClient();
  const prs = useQuery({
    queryKey: ["prs", workspaceId],
    queryFn: () => getPrs({ workspaceId }),
    refetchInterval: PR_POLL_MS,
  });
  const toggle = useMutation({
    mutationFn: (input: { url: string; followed: boolean }) => setFollowed({ workspaceId, ...input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["prs", workspaceId] }),
  });

  if (prs.isPending) return <Text style={styles.muted}>Loading…</Text>;
  if (prs.isError) return <Text style={styles.danger}>{prs.error.message}</Text>;
  const list = prs.data.prs;
  const following = list.filter((pr) => pr.followed).length;

  return (
    <View style={{ gap: 8, minWidth: layout.compact ? undefined : 380 }}>
      <Text style={styles.title}>Following</Text>
      <Text style={styles.muted}>
        The coordinator is told when a followed pull request changes: CI, conflicts, reviews, comments, merge or
        close. PRs are followed automatically when they're linked in the Project's notes or opened from a Project
        agent's branch. For timed check-ins, ask the coordinator to set a heartbeat.
      </Text>
      {!list.length && <Text style={styles.muted}>Nothing followed yet.</Text>}
      {list.map((pr) => (
        <View key={pr.url} style={[styles.entryRow, !pr.followed && styles.dim]}>
          <Icon name={PR_ICONS[pr.state]} size={15} color={prColor(theme, pr)} />
          <Text style={[styles.text, styles.flexText]} numberOfLines={1}>
            #{pr.number} {pr.title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${pr.followed ? "Unfollow" : "Follow"} pull request ${pr.number}`}
            disabled={toggle.isPending}
            onPress={() => toggle.mutate({ url: pr.url, followed: !pr.followed })}
          >
            <Text style={[styles.muted, styles.link]}>{pr.followed ? "Unfollow" : "Follow"}</Text>
          </Pressable>
        </View>
      ))}
      {toggle.isError && <Text style={styles.danger}>{toggle.error.message}</Text>}
      {list.length > 0 && <Text style={styles.muted}>Following {following} of {list.length}.</Text>}
    </View>
  );
}
