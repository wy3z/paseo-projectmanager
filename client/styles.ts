import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Platform } from "react-native";

export type Theme = PluginHostProps["theme"];
export type Styles = ReturnType<typeof makeStyles>;

export function makeStyles(theme: Theme, compact: boolean) {
  const mono = Platform.select({ ios: "Menlo", default: "monospace" });
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: compact ? 12 : 20, gap: compact ? 12 : 16 },
    headerRow: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    title: { color: theme.colors.foreground, fontSize: compact ? 18 : 20, fontWeight: "600" as const },
    text: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    dim: { opacity: 0.55 },
    link: { color: theme.colors.accent },
    bold: { fontWeight: "600" as const },
    code: { fontFamily: mono, fontSize: 12.5, color: theme.colors.foreground },
    path: { color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: mono },
    danger: { color: theme.colors.statusDanger, fontSize: 13 },
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, alignItems: "center" as const },
    tabBar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    projectIcon: { width: 18, height: 18, borderRadius: 4 },
    projectName: { color: theme.colors.foreground, fontSize: 15, fontWeight: "500" as const, flexShrink: 1 },
    tabs: { flexDirection: "row" as const, gap: 2, marginLeft: "auto" as const, opacity: 0.5 },
    tab: (active: boolean) => ({
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      backgroundColor: active ? theme.colors.surface1 : "transparent",
    }),
    tabText: (active: boolean) => ({
      color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
      fontSize: 12,
    }),
    card: {
      padding: compact ? 10 : 14,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      gap: 6,
    },
    sectionLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      fontWeight: "600" as const,
      textTransform: "uppercase" as const,
      letterSpacing: 0.5,
    },
    listRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8, paddingVertical: 5 },
    iconSlot: { paddingTop: 3 },
    flexText: { flex: 1 },
    heading: (level: number) => ({
      color: theme.colors.foreground,
      fontSize: level <= 1 ? 18 : level === 2 ? 16 : 14,
      fontWeight: "600" as const,
      marginTop: 6,
    }),
    codeBlock: {
      padding: 10,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    empty: { alignItems: "center" as const, gap: 6, paddingVertical: compact ? 32 : 56 },
    emptyTitle: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    entryRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingVertical: 6,
    },
  };
}
