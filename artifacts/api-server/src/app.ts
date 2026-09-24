import express, { type ErrorRequestHandler, type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { corsOptions } from "./lib/cors";
import resendWebhookRouter from "./routes/resend-webhook";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Signature verification must receive the original bytes, before JSON or auth middleware.
app.use("/api/webhooks/resend", express.raw({ type: "application/json", limit: "64kb" }), resendWebhookRouter);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors(corsOptions));
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const adminApiErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
  const path = req.originalUrl.split("?")[0] ?? req.path;
  if (path !== "/api/admin" && !path.startsWith("/api/admin/")) {
    next(error);
    return;
  }

  logger.error(
    {
      err: error,
      requestId: req.id,
      method: req.method,
      path,
    },
    "Unexpected admin API failure",
  );

  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(500).json({
    error: "An unexpected error occurred while processing the admin request.",
  });
};

app.use(adminApiErrorHandler);

export default app;
