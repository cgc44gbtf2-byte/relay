import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  adminAuditLogsTable,
  db,
  developerReleasesTable,
  developerSettingsTable,
  notificationsTable,
  serverAnnouncementsTable,
  usersTable,
} from "@workspace/db";
import { ensureProfile, getUserId, requireAuth, type AuthenticatedRequest } from "../lib/auth";

const router: IRouter = Router();

const DEFAULT_SETTINGS = {
  siteName: "relay",
  landingEyebrow: "a quieter kind of social",
  landingTitle: "Real rooms.\nReal presence.",
  landingDescription: "Relay brings the immediacy of IRC to the browser, with public channels, direct messages, profiles, and the tools communities need to stay kind.",
  networkStatusLabel: "live and open",
} as const;
type AppSettings = { -readonly [Key in keyof typeof DEFAULT_SETTINGS]: string };

function settingsFromRows(rows: Array<{ key: string; value: string }>): AppSettings {
  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in settings) {
      const key = row.key as keyof AppSettings;
      settings[key] = row.value;
    }
  }
  return settings;
}

const SETTING_LIMITS: Record<keyof typeof DEFAULT_SETTINGS, number> = {
  siteName: 40,
  landingEyebrow: 80,
  landingTitle: 120,
  landingDescription: 360,
  networkStatusLabel: 40,
};

type ReleaseStatus = "draft" | "review" | "published" | "archived";

async function developerProfile(req: AuthenticatedRequest) {
  const profile = await ensureProfile(getUserId(req));
  return profile.role === "admin" ? profile : null;
}

async function writeDeveloperAudit(
  actorId: string,
  actorDisplayName: string,
  action: string,
  targetId?: string,
  targetLabel?: string,
  details?: string,
): Promise<void> {
  await db.insert(adminAuditLogsTable).values({
    actorId,
    actorDisplayName,
    action,
    targetId,
    targetLabel,
    details,
  });
}

router.get("/app-config", async (_req, res): Promise<void> => {
  const rows = await db.select().from(developerSettingsTable);
  res.json(settingsFromRows(rows));
});

router.get("/developer/settings", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await developerProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Developer access required." });
    return;
  }
  const rows = await db.select().from(developerSettingsTable);
  res.json(settingsFromRows(rows));
});

router.patch("/developer/settings", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await developerProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Developer access required." });
    return;
  }
  const updates = Object.entries(DEFAULT_SETTINGS)
    .filter(([key]) => typeof req.body?.[key] === "string")
    .map(([key]) => [key, String(req.body[key]).trim().slice(0, SETTING_LIMITS[key as keyof typeof DEFAULT_SETTINGS])] as const);
  if (!updates.length) {
    res.status(400).json({ error: "At least one valid application setting is required." });
    return;
  }
  for (const [key, value] of updates) {
    await db.insert(developerSettingsTable).values({
      key,
      value,
      updatedBy: actor.clerkId,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: developerSettingsTable.key,
      set: { value, updatedBy: actor.clerkId, updatedAt: new Date() },
    });
  }
  await writeDeveloperAudit(actor.clerkId, actor.displayName, "updated_application_settings", undefined, "developer settings", updates.map(([key]) => key).join(", "));
  const rows = await db.select().from(developerSettingsTable);
  res.json(settingsFromRows(rows));
});

router.get("/developer/releases", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!(await developerProfile(req))) {
    res.status(403).json({ error: "Developer access required." });
    return;
  }
  res.json(await db.select().from(developerReleasesTable).orderBy(desc(developerReleasesTable.createdAt)));
});

router.post("/developer/releases", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await developerProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Developer access required." });
    return;
  }
  const version = typeof req.body?.version === "string" ? req.body.version.trim().slice(0, 40) : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 120) : "";
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 4000) : "";
  if (!version || !title) {
    res.status(400).json({ error: "A release version and title are required." });
    return;
  }
  const [release] = await db.insert(developerReleasesTable).values({
    version,
    title,
    notes,
    createdBy: actor.clerkId,
  }).returning();
  await writeDeveloperAudit(actor.clerkId, actor.displayName, "created_application_release", String(release.id), `${release.version} · ${release.title}`);
  res.status(201).json(release);
});

router.patch("/developer/releases/:releaseId/status", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await developerProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Developer access required." });
    return;
  }
  const releaseId = Number(Array.isArray(req.params.releaseId) ? req.params.releaseId[0] : req.params.releaseId);
  const nextStatus = req.body?.status as ReleaseStatus;
  if (!Number.isSafeInteger(releaseId) || releaseId < 1 || !["draft", "review", "published", "archived"].includes(nextStatus)) {
    res.status(400).json({ error: "A valid release and status are required." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(developerReleasesTable)
      .where(eq(developerReleasesTable.id, releaseId))
      .for("update");
    if (!current) return { kind: "not_found" as const };

    const validTransition =
      (current.status === "draft" && nextStatus === "review")
      || (current.status === "review" && (nextStatus === "draft" || nextStatus === "published"))
      || (current.status === "published" && nextStatus === "archived");
    if (!validTransition) return { kind: "invalid_transition" as const, currentStatus: current.status };

    const now = new Date();
    const [release] = await tx.update(developerReleasesTable).set({
      status: nextStatus,
      ...(nextStatus === "review" ? { reviewedBy: actor.clerkId, reviewedAt: now } : {}),
      ...(nextStatus === "published" ? { publishedBy: actor.clerkId, publishedAt: now } : {}),
    }).where(eq(developerReleasesTable.id, releaseId)).returning();
    if (!release) throw new Error("Release update failed.");

    let updatedRelease = release;
    if (nextStatus === "published" && !release.announcementId) {
      const [draft] = await tx.insert(serverAnnouncementsTable).values({
        authorId: actor.clerkId,
        title: `Release ${release.version}: ${release.title}`,
        body: release.notes || `Release ${release.version} is ready for announcement review.`,
        audienceType: "company",
        status: "draft",
      }).returning({ id: serverAnnouncementsTable.id });
      if (!draft) throw new Error("Release announcement draft could not be created.");
      const [linked] = await tx.update(developerReleasesTable)
        .set({ announcementId: draft.id })
        .where(eq(developerReleasesTable.id, release.id))
        .returning();
      if (!linked) throw new Error("Release announcement draft could not be linked.");
      updatedRelease = linked;
    }

    await tx.insert(adminAuditLogsTable).values({
      actorId: actor.clerkId,
      actorDisplayName: actor.displayName,
      action: `release_${nextStatus}`,
      targetId: String(updatedRelease.id),
      targetLabel: `${updatedRelease.version} · ${updatedRelease.title}`,
    });
    return { kind: "updated" as const, release: updatedRelease };
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Release not found." });
    return;
  }
  if (result.kind === "invalid_transition") {
    res.status(400).json({ error: `A ${result.currentStatus} release cannot move to ${nextStatus}.` });
    return;
  }
  res.json(result.release);
});

router.patch("/developer/releases/:releaseId/announcement", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await developerProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Developer access required." });
    return;
  }
  const releaseId = Number(Array.isArray(req.params.releaseId) ? req.params.releaseId[0] : req.params.releaseId);
  if (!Number.isSafeInteger(releaseId) || releaseId < 1 || req.body?.status !== "published") {
    res.status(400).json({ error: "A valid release and announcement status are required." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [release] = await tx.select().from(developerReleasesTable)
      .where(eq(developerReleasesTable.id, releaseId))
      .for("update");
    if (!release) return { kind: "release_not_found" as const };
    if (release.status !== "published") return { kind: "release_not_published" as const };

    if (!release.announcementId) {
      const [draft] = await tx.insert(serverAnnouncementsTable).values({
        authorId: actor.clerkId,
        title: `Release ${release.version}: ${release.title}`,
        body: release.notes || `Release ${release.version} is ready for announcement review.`,
        audienceType: "company",
        status: "draft",
      }).returning();
      if (!draft) throw new Error("Release announcement draft could not be restored.");
      const [linkedRelease] = await tx.update(developerReleasesTable)
        .set({ announcementId: draft.id })
        .where(and(
          eq(developerReleasesTable.id, release.id),
          eq(developerReleasesTable.status, "published"),
        ))
        .returning();
      if (!linkedRelease) throw new Error("Release announcement draft could not be linked.");
      return { kind: "draft_restored" as const, release: linkedRelease, announcement: draft };
    }

    const [linkedAnnouncement] = await tx.select().from(serverAnnouncementsTable)
      .where(eq(serverAnnouncementsTable.id, release.announcementId))
      .for("update");
    if (!linkedAnnouncement) return { kind: "announcement_not_found" as const };
    if (linkedAnnouncement.status !== "draft") {
      return { kind: "invalid_announcement_transition" as const, announcementStatus: linkedAnnouncement.status };
    }

    const [announcement] = await tx.update(serverAnnouncementsTable).set({ status: "published" })
      .where(and(
        eq(serverAnnouncementsTable.id, linkedAnnouncement.id),
        eq(serverAnnouncementsTable.status, "draft"),
      ))
      .returning();
    if (!announcement) return { kind: "announcement_unavailable" as const };

    const recipients = await tx.select({ userId: usersTable.clerkId }).from(usersTable);
    if (recipients.length) {
      await tx.insert(notificationsTable).values(recipients.map((recipient) => ({
        userId: recipient.userId,
        type: "server_announcement",
        category: "announcement",
        body: `${announcement.title}: ${announcement.body}`,
        entityType: "server_announcement",
        entityId: String(announcement.id),
      })));
    }
    await tx.insert(adminAuditLogsTable).values({
      actorId: actor.clerkId,
      actorDisplayName: actor.displayName,
      action: "published_release_announcement",
      targetId: String(announcement.id),
      targetLabel: "release announcement",
      details: `${release.version} · ${release.title}`,
    });
    return { kind: "published" as const, release, announcement };
  });

  if (result.kind === "release_not_found") {
    res.status(404).json({ error: "Release not found." });
    return;
  }
  if (result.kind === "release_not_published") {
    res.status(400).json({ error: "Publish the release before publishing its announcement." });
    return;
  }

  if (result.kind === "draft_restored") {
    res.status(409).json({
      error: "The linked announcement draft was missing. A replacement draft was created and must be published separately.",
      release: result.release,
      announcement: result.announcement,
    });
    return;
  }
  if (result.kind === "announcement_not_found" || result.kind === "announcement_unavailable") {
    res.status(409).json({ error: "The linked release announcement is unavailable." });
    return;
  }
  if (result.kind === "invalid_announcement_transition") {
    res.status(409).json({
      error: `A ${result.announcementStatus} release announcement cannot be published.`,
    });
    return;
  }
  res.json({ release: result.release, announcement: result.announcement });
});

export default router;