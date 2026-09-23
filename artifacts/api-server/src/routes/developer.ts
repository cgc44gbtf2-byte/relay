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
  if (!Number.isInteger(releaseId) || !["draft", "review", "published", "archived"].includes(nextStatus)) {
    res.status(400).json({ error: "A valid release and status are required." });
    return;
  }
  const [current] = await db.select().from(developerReleasesTable).where(eq(developerReleasesTable.id, releaseId));
  if (!current) {
    res.status(404).json({ error: "Release not found." });
    return;
  }
  const validTransition =
    (current.status === "draft" && nextStatus === "review")
    || (current.status === "review" && (nextStatus === "draft" || nextStatus === "published"))
    || (current.status === "published" && nextStatus === "archived");
  if (!validTransition) {
    res.status(400).json({ error: `A ${current.status} release cannot move to ${nextStatus}.` });
    return;
  }
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [release] = await tx.update(developerReleasesTable).set({
      status: nextStatus,
      ...(nextStatus === "review" ? { reviewedBy: actor.clerkId, reviewedAt: now } : {}),
      ...(nextStatus === "published" ? { publishedBy: actor.clerkId, publishedAt: now } : {}),
    }).where(eq(developerReleasesTable.id, releaseId)).returning();
    if (!release) throw new Error("Release update failed.");
    if (nextStatus !== "published" || release.announcementId) return release;
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
    return linked;
  });
  await writeDeveloperAudit(actor.clerkId, actor.displayName, `release_${nextStatus}`, String(updated.id), `${updated.version} · ${updated.title}`);
  res.json(updated);
});

router.patch("/developer/releases/:releaseId/announcement", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await developerProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Developer access required." });
    return;
  }
  const releaseId = Number(Array.isArray(req.params.releaseId) ? req.params.releaseId[0] : req.params.releaseId);
  if (!Number.isInteger(releaseId) || req.body?.status !== "published") {
    res.status(400).json({ error: "A valid release and announcement status are required." });
    return;
  }
  const [release] = await db.select().from(developerReleasesTable).where(eq(developerReleasesTable.id, releaseId));
  if (!release) {
    res.status(404).json({ error: "Release not found." });
    return;
  }
  if (release.status !== "published" || !release.announcementId) {
    if (release.status !== "published") {
      res.status(400).json({ error: "Publish the release before publishing its announcement." });
      return;
    }
  }
  const result = await db.transaction(async (tx) => {
    const [linkedAnnouncement] = release.announcementId
      ? await tx.select().from(serverAnnouncementsTable).where(eq(serverAnnouncementsTable.id, release.announcementId))
      : [];
    if (linkedAnnouncement && linkedAnnouncement.status !== "draft") return null;
    if (linkedAnnouncement) {
      const [announcement] = await tx.update(serverAnnouncementsTable).set({ status: "published" })
        .where(and(
          eq(serverAnnouncementsTable.id, linkedAnnouncement.id),
          eq(serverAnnouncementsTable.status, "draft"),
        )).returning();
      return announcement ? { release, announcement } : null;
    }
    const [draft] = await tx.insert(serverAnnouncementsTable).values({
      authorId: actor.clerkId,
      title: `Release ${release.version}: ${release.title}`,
      body: release.notes || `Release ${release.version} is ready for announcement review.`,
      audienceType: "company",
      status: "published",
    }).returning();
    if (!draft) return null;
    const [linkedRelease] = await tx.update(developerReleasesTable)
      .set({ announcementId: draft.id })
      .where(and(
        eq(developerReleasesTable.id, release.id),
        eq(developerReleasesTable.status, "published"),
      )).returning();
    return linkedRelease ? { release: linkedRelease, announcement: draft } : null;
  });
  if (!result) {
    res.status(409).json({ error: "This release announcement is already published or unavailable." });
    return;
  }
  const { release: linkedRelease, announcement } = result;
  const recipients = await db.select({ userId: usersTable.clerkId }).from(usersTable);
  if (recipients.length) {
    await db.insert(notificationsTable).values(recipients.map((recipient) => ({
      userId: recipient.userId,
      type: "server_announcement",
      category: "announcement",
      body: `${announcement.title}: ${announcement.body}`,
    })));
  }
  await writeDeveloperAudit(
    actor.clerkId,
    actor.displayName,
    "published_release_announcement",
    String(announcement.id),
    "release announcement",
    `${linkedRelease.version} · ${linkedRelease.title}`,
  );
  res.json({ release: linkedRelease, announcement });
});

export default router;