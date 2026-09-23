type WorkspaceChannel = {
  communityId: number | null;
  communityName?: string | null;
};

export function WorkspaceIndicator({
  channel,
  isDirectMessage,
}: {
  channel: WorkspaceChannel | null;
  isDirectMessage: boolean;
}) {
  const context = isDirectMessage
    ? { label: "workspace", name: "None · direct message", description: "Direct message outside a workspace" }
    : !channel
      ? { label: "workspace", name: "None selected", description: "No workspace selected" }
      : channel.communityId === null
        ? { label: "network", name: "Public network", description: "Public network, outside a workspace" }
        : {
            label: "workspace",
            name: channel.communityName?.trim() || `Workspace #${channel.communityId}`,
            description: `Current workspace: ${channel.communityName?.trim() || `Workspace #${channel.communityId}`}`,
          };

  return (
    <div
      data-testid="workspace-indicator"
      aria-label={context.description}
      title={context.description}
      className="mb-1 flex max-w-full items-center gap-1.5 font-mono text-[10px]"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
      <span className="shrink-0 uppercase tracking-[.13em] text-muted-foreground">{context.label}</span>
      <span className="min-w-0 truncate font-semibold text-primary">{context.name}</span>
    </div>
  );
}