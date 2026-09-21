import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ircRouter from "./irc";
import { requireAuth, getUserId, type AuthenticatedRequest } from "../lib/auth";
import { wsHub } from "../lib/ws";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ircRouter);
router.get("/ws-ticket", requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ ticket: wsHub.issueTicket(getUserId(req)) });
});

export default router;
