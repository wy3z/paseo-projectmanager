import { openExternalUrl, useAgent } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { PullRequest } from "../shared/contracts";
import { type Block, classifyLink, type LinkTarget, parseInline } from "./notes-format";
import { WorkerReviewChip } from "./review-view";
import type { Styles, Theme } from "./styles";

// Renders store Markdown as plain, read-only Markdown, with read-only checkboxes and links
// decorated with agent or PR state.

export interface LinkContext {
  styles: Styles;
  theme: Theme;
  contextDir: string;
  prs: ReadonlyMap<string, PullRequest>;
  openAgent?: (agentId: string) => void;
  review?: { workspaceId: string; open(agentId: string): void };
  /** Opens a store file, given relative to the store. */
  openFile: (path: string) => void;
  /** Opens a local path from the notes, such as ~/Projects/app. */
  openPath: (path: string) => void;
}

export const PR_ICONS: Record<PullRequest["state"], string> = {
  open: "GitPullRequest",
  draft: "GitPullRequestDraft",
  merged: "GitMerge",
  closed: "GitPullRequestClosed",
};

export function prColor(theme: Theme, pr: PullRequest | undefined) {
  if (!pr) return theme.colors.foregroundMuted;
  if (pr.state === "open") return theme.colors.statusSuccess;
  if (pr.state === "merged") return theme.colors.accent;
  if (pr.state === "closed") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

/** The status glyph shown before a checklist row's first link. */
function LinkIcon({ target, ctx }: { target: LinkTarget; ctx: LinkContext }) {
  if (target.kind === "agent") return <AgentIcon agentId={target.agentId} theme={ctx.theme} />;
  if (target.kind === "pr") {
    const pr = ctx.prs.get(target.url);
    return <Icon name={pr ? PR_ICONS[pr.state] : "GitPullRequest"} size={15} color={prColor(ctx.theme, pr)} />;
  }
  if (target.kind === "file") return <Icon name="FileText" size={15} color={ctx.theme.colors.foregroundMuted} />;
  return null;
}

export function agentIconFor(status: string | undefined) {
  if (status === "running" || status === "initializing") return "LoaderCircle";
  if (status === "error") return "CircleAlert";
  return "Bot";
}

function AgentIcon({ agentId, theme }: { agentId: string; theme: Theme }) {
  const status = useAgent(agentId, (agent) => agent.status);
  const color =
    status === "running" || status === "initializing"
      ? theme.colors.accent
      : status === "error"
        ? theme.colors.statusDanger
        : theme.colors.foregroundMuted;
  return <Icon name={agentIconFor(status ?? undefined)} size={15} color={color} />;
}

function AgentLabel({ agentId, label }: { agentId: string; label: string }) {
  const title = useAgent(agentId, (agent) => agent.title);
  const clean = label.replace(/^@/, "").trim();
  return <>{clean || title || agentId.slice(0, 8)}</>;
}

function Inline({ text, ctx }: { text: string; ctx: LinkContext }) {
  const { styles } = ctx;
  return (
    <>
      {parseInline(text).map((segment, index) => {
        if (segment.kind === "text") {
          const style = segment.code ? styles.code : segment.bold ? styles.bold : undefined;
          return (
            <Text key={index} style={style}>
              {segment.text}
            </Text>
          );
        }
        if (segment.kind === "path") {
          return (
            <Text
              key={index}
              style={segment.code ? [styles.code, styles.link] : styles.link}
              onPress={() => ctx.openPath(segment.path)}
              accessibilityRole="link"
            >
              {segment.path}
            </Text>
          );
        }
        const target = classifyLink(segment.href, ctx.contextDir);
        const onPress = () => {
          if (target.kind === "agent") ctx.openAgent?.(target.agentId);
          else if (target.kind === "file") ctx.openFile(target.path);
          else void openExternalUrl(target.url);
        };
        return (
          <Text key={index} style={styles.link} onPress={onPress} accessibilityRole="link">
            {target.kind === "agent" ? <AgentLabel agentId={target.agentId} label={segment.label} /> : segment.label}
          </Text>
        );
      })}
    </>
  );
}

function firstLink(text: string, contextDir: string): LinkTarget | null {
  const segment = parseInline(text).find((part) => part.kind === "link");
  return segment?.kind === "link" ? classifyLink(segment.href, contextDir) : null;
}

export function MarkdownBlocks({ blocks, ctx }: { blocks: readonly Block[]; ctx: LinkContext }) {
  const { styles, theme } = ctx;
  return (
    <View>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <Text key={index} style={styles.heading(block.level)}>
                <Inline text={block.text} ctx={ctx} />
              </Text>
            );
          case "paragraph":
            return (
              <Text key={index} style={[styles.text, { marginVertical: 4 }]}>
                <Inline text={block.text} ctx={ctx} />
              </Text>
            );
          case "code":
            return (
              <View key={index} style={[styles.codeBlock, { marginVertical: 4 }]}>
                <Text selectable style={styles.code}>
                  {block.text}
                </Text>
              </View>
            );
          case "item": {
            const link = firstLink(block.text, ctx.contextDir);
            return (
              <View key={index} style={[styles.listRow, { paddingLeft: block.depth * 18 }]}>
                <View style={styles.iconSlot}>
                  {block.checked === null ? (
                    <Text style={styles.muted}>•</Text>
                  ) : (
                    <Icon
                      name={block.checked ? "CircleCheck" : "Circle"}
                      size={16}
                      color={theme.colors.foregroundMuted}
                    />
                  )}
                </View>
                {link && link.kind !== "web" && (
                  <View style={styles.iconSlot}>
                    <LinkIcon target={link} ctx={ctx} />
                  </View>
                )}
                <View style={[styles.flexText, { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }]}>
                  <Text style={[styles.text, { flexShrink: 1 }]}>
                    <Inline text={block.text} ctx={ctx} />
                  </Text>
                  {block.checked !== null && link?.kind === "agent" && ctx.review && (
                    <WorkerReviewChip
                      workspaceId={ctx.review.workspaceId}
                      agentId={link.agentId}
                      theme={theme}
                      onPress={() => ctx.review?.open(link.agentId)}
                    />
                  )}
                </View>
              </View>
            );
          }
        }
      })}
    </View>
  );
}

/** The "Focus" card, from a leading <tldr> block. */
export function FocusCard({ text, ctx }: { text: string; ctx: LinkContext }) {
  return (
    <View style={ctx.styles.card}>
      <Text style={ctx.styles.sectionLabel}>Focus</Text>
      <Text style={ctx.styles.text}>
        <Inline text={text} ctx={ctx} />
      </Text>
    </View>
  );
}
