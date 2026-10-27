const express = require("express");
const createBotsRouter = require("./bots");
const { Client } = require("magic-hour");
const { GoogleGenAI } = require("@google/genai");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;


const databaseReady = pool
  ? (async () => {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS cineflow_projects (
            id TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
             await pool.query(`
          CREATE TABLE IF NOT EXISTS cineflow_images (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            scene_number INTEGER,
            mime_type TEXT NOT NULL DEFAULT 'image/png',
            data TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        // CINEFLOW WALLET : COMPTES DES CRÉATEURS
        await pool.query(`
          CREATE TABLE IF NOT EXISTS cineflow_wallets (
            user_id TEXT PRIMARY KEY,
            currency TEXT NOT NULL DEFAULT 'XOF',
            balance_minor BIGINT NOT NULL DEFAULT 0
              CHECK (balance_minor >= 0),
            pending_minor BIGINT NOT NULL DEFAULT 0
              CHECK (pending_minor >= 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
// Colonnes ImageKit — migration sans supprimer les images existantes
await pool.query(`
  ALTER TABLE cineflow_images
  ADD COLUMN IF NOT EXISTS imagekit_url TEXT,
  ADD COLUMN IF NOT EXISTS imagekit_file_id TEXT
`);
        // HISTORIQUE IMMUTABLE DES OPÉRATIONS
        await pool.query(`
          CREATE TABLE IF NOT EXISTS cineflow_wallet_transactions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            type TEXT NOT NULL CHECK (
              type IN (
                'earning',
                'withdrawal',
                'refund',
                'adjustment'
              )
            ),
            amount_minor BIGINT NOT NULL
              CHECK (amount_minor > 0),
            currency TEXT NOT NULL DEFAULT 'XOF',
            status TEXT NOT NULL CHECK (
              status IN (
                'pending',
                'confirmed',
                'rejected',
                'paid'
              )
            ),
            reference TEXT UNIQUE,
            description TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        // DEMANDES DE RETRAIT
        await pool.query(`
          CREATE TABLE IF NOT EXISTS cineflow_wallet_withdrawals (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            amount_minor BIGINT NOT NULL
              CHECK (amount_minor > 0),
            currency TEXT NOT NULL DEFAULT 'XOF',
            method TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK (
                status IN (
                  'pending',
                  'approved',
                  'processing',
                  'paid',
                  'rejected',
                  'cancelled'
                )
              ),
            provider_reference TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS
          cineflow_wallet_transactions_user_idx
          ON cineflow_wallet_transactions (user_id, created_at DESC)
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS
          cineflow_wallet_withdrawals_user_idx
          ON cineflow_wallet_withdrawals (user_id, created_at DESC)
        `);
await pool.query(`
  CREATE TABLE IF NOT EXISTS cineflow_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
        console.log("Neon : tables prêtes.");
        return true;
      } catch (error) {
        console.error("Erreur Neon :", error.message);
        return false;
      }
    })()
  : Promise.resolve(false);


const app = express();

app.use(express.json({ limit: "120mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

const JWT_SECRET = process.env.JWT_SECRET;
// =========================================================
// IMAGEKIT — STOCKAGE DES IMAGES CINEFLOW
// =========================================================

const IMAGEKIT_PRIVATE_KEY =
  process.env.IMAGEKIT_PRIVATE_KEY;

const IMAGEKIT_URL_ENDPOINT =
  process.env.IMAGEKIT_URL_ENDPOINT;

const IMAGEKIT_UPLOAD_URL =
  "https://upload.imagekit.io/api/v1/files/upload";

const IMAGEKIT_ENABLED = Boolean(
  IMAGEKIT_PRIVATE_KEY &&
  IMAGEKIT_URL_ENDPOINT
);
// Vérifie que l'utilisateur possède un jeton valide.
function requireAuth(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(503).json({
      success: false,
      error: "Authentification non configurée."
    });
  }

  const authorization = req.headers.authorization || "";
  const parts = authorization.split(" ");

  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({
      success: false,
      error: "Connexion requise."
    });
  }

  try {
    const payload = jwt.verify(parts[1], JWT_SECRET);

    if (!payload.sub) {
      throw new Error("Jeton sans identifiant utilisateur.");
    }

    req.user = { id: payload.sub };
    next();
  } catch {
    return res.status(401).json({
      success: false,
      error: "Jeton invalide ou expiré."
    });
  }
}

// Inscription d'un créateur.
app.post("/api/auth/register", async (req, res) => {
  try {
    if (!pool || !(await databaseReady)) {
      return res.status(503).json({
        success: false,
        error: "Base de données indisponible."
      });
    }

    if (!JWT_SECRET || JWT_SECRET.length < 32) {
      return res.status(503).json({
        success: false,
        error: "JWT_SECRET doit être configuré."
      });
    }

    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = req.body?.password;

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        success: false,
        error: "Adresse e-mail invalide."
      });
    }

    if (
      typeof password !== "string" ||
      password.length < 12 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).json({
        success: false,
        error: "Le mot de passe doit contenir au moins 12 caractères et au maximum 72 octets."
      });
    }

    const id = require("crypto").randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO cineflow_users (id, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email`,
      [id, email, passwordHash]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        success: false,
        error: "Impossible de créer ce compte avec cette adresse."
      });
    }

    await pool.query(
      `INSERT INTO cineflow_wallets (user_id, currency)
       VALUES ($1, 'XOF')
       ON CONFLICT (user_id) DO NOTHING`,
      [id]
    );

    const token = jwt.sign(
      { sub: id },
      JWT_SECRET,
      { expiresIn: "7d", algorithm: "HS256" }
    );

    return res.status(201).json({
      success: true,
      user: result.rows[0],
      token
    });
  } catch (error) {
    console.error("Inscription Cineflow :", error.message);
    return res.status(500).json({
      success: false,
      error: "Erreur pendant l'inscription."
    });
  }
});

// Connexion d'un créateur.
app.post("/api/auth/login", async (req, res) => {
  try {
    if (!pool || !(await databaseReady)) {
      return res.status(503).json({
        success: false,
        error: "Base de données indisponible."
      });
    }

    if (!JWT_SECRET || JWT_SECRET.length < 32) {
      return res.status(503).json({
        success: false,
        error: "JWT_SECRET doit être configuré."
      });
    }

    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = req.body?.password;

    if (
      !email ||
      email.length > 254 ||
      typeof password !== "string" ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res.status(400).json({
        success: false,
        error: "Identifiants invalides."
      });
    }

    const result = await pool.query(
      `SELECT id, email, password_hash
       FROM cineflow_users
       WHERE email = $1`,
      [email]
    );

    if (
      result.rowCount !== 1 ||
      !(await bcrypt.compare(
        password,
        result.rows[0].password_hash
      ))
    ) {
      return res.status(401).json({
        success: false,
        error: "E-mail ou mot de passe incorrect."
      });
    }

    const user = result.rows[0];
    const token = jwt.sign(
      { sub: user.id },
      JWT_SECRET,
      { expiresIn: "7d", algorithm: "HS256" }
    );

    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email
      },
      token
    });
  } catch (error) {
    console.error("Connexion Cineflow :", error.message);
    return res.status(500).json({
      success: false,
      error: "Erreur pendant la connexion."
    });
  }
});

// Vérifier le compte connecté.
app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, created_at
       FROM cineflow_users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        success: false,
        error: "Compte introuvable."
      });
    }

    return res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error("Vérification du compte :", error.message);
    return res.status(500).json({
      success: false,
      error: "Impossible de vérifier le compte."
    });
  }
});
// ==================================================
// PORTEFEUILLE CINEFLOW — SOLDE DE L'UTILISATEUR
// ==================================================
app.get("/api/wallet", requireAuth, async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: "Base de données indisponible."
      });
    }

    await databaseReady;

    const result = await pool.query(
      `SELECT currency, balance_minor, pending_minor
       FROM cineflow_wallets
       WHERE user_id = $1
       LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Portefeuille introuvable."
      });
    }

    const wallet = result.rows[0];

    return res.json({
      success: true,
      wallet: {
        currency: wallet.currency,
        balance: wallet.balance_minor,
        pending: wallet.pending_minor
      }
    });
  } catch (error) {
    console.error(
      "Erreur lecture portefeuille :",
      error.message
    );

    return res.status(500).json({
      success: false,
      error: "Impossible de récupérer le portefeuille."
    });
  }
});
// ==================================================
// PORTEFEUILLE CINEFLOW — HISTORIQUE DES TRANSACTIONS
// ==================================================
app.get(
  "/api/wallet/transactions",
  requireAuth,
  async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({
          success: false,
          error: "Base de données indisponible."
        });
      }

      await databaseReady;

      const result = await pool.query(
        `SELECT
           id,
           type,
           amount_minor,
           currency,
           status,
           reference,
           created_at
         FROM cineflow_wallet_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [req.user.id]
      );

      return res.json({
        success: true,
        count: result.rows.length,
        transactions: result.rows
      });
    } catch (error) {
      console.error(
        "Erreur historique portefeuille :",
        error.message
      );

      return res.status(500).json({
        success: false,
        error: "Impossible de récupérer l'historique."
      });
    }
  }
);
const CLOUDFLARE_API_TOKEN =
  process.env.CLOUDFLARE_API_TOKEN;

const CLOUDFLARE_ACCOUNT_ID =
  process.env.CLOUDFLARE_ACCOUNT_ID;

const CLOUDFLARE_IMAGE_MODEL =
  "@cf/black-forest-labs/flux-2-klein-4b";

const MODEL = "gemini-3.7-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";
const VIDEO_MODEL = "veo-3.1-generate-preview";

const ai = API_KEY
  ? new GoogleGenAI({ apiKey: API_KEY })
  : null;

/* =========================================================
   DATA
========================================================= */


const projects = [];
const jobs = new Map();
const generatedImages = new Map();
const generatedVideos = new Map();
const series = [];
let botsRouter;

botsRouter = createBotsRouter({
  projects,
  jobs,
  generatedImages,
  generatedVideos,
  pool,
  databaseReady,
  retryScene: retryQueuedVideoScene,
  providers: {
    gemini: Boolean(process.env.GEMINI_API_KEY),
    magicHour: Boolean(process.env.MAGIC_HOUR_API_KEY),
    cloudflare: Boolean(
      process.env.CLOUDFLARE_API_TOKEN &&
      process.env.CLOUDFLARE_ACCOUNT_ID
    )
  }
});

app.use("/api/bots", botsRouter);

async function saveProjectToDatabase(project) {
  if (!pool || !project) {
    return false;
  }

  try {
    await databaseReady;

    await pool.query(
      `INSERT INTO cineflow_projects (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id)
       DO UPDATE SET
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [project.id, JSON.stringify(project)]
    );

    return true;
  } catch (error) {
    console.error(
      "Erreur de sauvegarde Neon :",
      error.message
    );

    return false;
  }
}
// =========================================================
// ENVOI D'UNE IMAGE VERS IMAGEKIT
// =========================================================

async function uploadImageToImageKit(imageId, image) {
  if (
    !IMAGEKIT_ENABLED ||
    !imageId ||
    !image?.data
  ) {
    return null;
  }

  try {
    const imageBuffer = Buffer.from(
      image.data,
      "base64"
    );

    const form = new FormData();

    form.append(
      "file",
      new Blob(
        [imageBuffer],
        { type: image.mimeType || "image/png" }
      ),
      `${imageId}.png`
    );

    form.append("fileName", `${imageId}.png`);
form.append("folder", "/cineflow");
form.append("useUniqueFileName", "false");
form.append("overwriteFile", "true");

    const response = await fetch(
      IMAGEKIT_UPLOAD_URL,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              IMAGEKIT_PRIVATE_KEY + ":"
            ).toString("base64")
        },
        body: form
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error(
        "ImageKit : échec de l'envoi :",
        result.message || response.status
      );

      return null;
    }

    console.log(
      "Image envoyée vers ImageKit :",
      imageId
    );

    return {
      url: result.url || null,
      fileId: result.fileId || null
    };
  } catch (error) {
    console.error(
      "Erreur ImageKit :",
      error.message
    );

    return null;
  }
}
async function saveImageToDatabase(imageId, image) {
  if (!pool || !imageId || !image?.data) {
    return false;
  }

  try {
    const ready = await databaseReady;
    if (!ready) return false;

    // Envoi facultatif vers ImageKit.
    // Si ImageKit échoue, Neon reste la sauvegarde principale.
    let imageKitResult = null;

    if (IMAGEKIT_ENABLED) {
      imageKitResult = await uploadImageToImageKit(
        imageId,
        image
      );
    }

    await pool.query(
      `INSERT INTO cineflow_images
        (
          id,
          project_id,
          scene_number,
          mime_type,
          data,
          imagekit_url,
          imagekit_file_id,
          updated_at
        )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         scene_number = EXCLUDED.scene_number,
         mime_type = EXCLUDED.mime_type,
         data = EXCLUDED.data,
         imagekit_url = COALESCE(
           EXCLUDED.imagekit_url,
           cineflow_images.imagekit_url
         ),
         imagekit_file_id = COALESCE(
           EXCLUDED.imagekit_file_id,
           cineflow_images.imagekit_file_id
         ),
         updated_at = NOW()`,
      [
        imageId,
        image.projectId,
        Number(image.scene) || null,
        image.mimeType || "image/png",
        image.data,
        imageKitResult?.url || image.imagekitUrl || null,
        imageKitResult?.fileId || image.imagekitFileId || null
      ]
    );

    // Conserve également les références en mémoire.
    if (imageKitResult) {
      image.imagekitUrl = imageKitResult.url;
      image.imagekitFileId = imageKitResult.fileId;
    }

    return true;
  } catch (error) {
    console.error(
      "Erreur de sauvegarde image Neon :",
      error.message
    );

    return false;
  }
}
async function loadImageFromDatabase(imageId) {
  if (!pool || !imageId) return null;

  try {
    const ready = await databaseReady;
    if (!ready) return null;

    const result = await pool.query(
      `SELECT
         id,
         project_id,
         scene_number,
         mime_type,
         data,
         imagekit_url,
         imagekit_file_id
       FROM cineflow_images
       WHERE id = $1
       LIMIT 1`,
      [imageId]
    );

    if (!result.rows.length) return null;

    const row = result.rows[0];

    const image = {
      id: row.id,
      projectId: row.project_id,
      scene: row.scene_number,
      mimeType: row.mime_type || "image/png",
      data: row.data,
      imagekitUrl: row.imagekit_url || null,
      imagekitFileId: row.imagekit_file_id || null
    };

    generatedImages.set(imageId, image);

    return image;
  } catch (error) {
    console.error(
      "Erreur de récupération image Neon :",
      error.message
    );

    return null;
  }
}
  async function getImageData(imageId) {
  const image = generatedImages.get(imageId);

  if (image?.data) return image;

  return await loadImageFromDatabase(imageId);
  }
const accounts = {
  youtube: false,
  tiktok: false,
  instagram: false
};

const platformStats = {
  youtube: {
    connected: false,
    views: 0,
    likes: 0,
    subscribers: 0,
    revenue: 0
  },

  tiktok: {
    connected: false,
    views: 0,
    likes: 0,
    subscribers: 0,
    revenue: 0
  },

  instagram: {
    connected: false,
    views: 0,
    likes: 0,
    subscribers: 0,
    revenue: 0
  }
};

async function retryQueuedVideoScene(projectId, sceneNumber) {
  let project = projects.find(
    (item) => item.id === projectId
  );

  // Si le projet n'est plus en mémoire,
  // tenter de le restaurer depuis Neon.
  if (!project && pool) {
    const databaseAvailable = await databaseReady;

    if (databaseAvailable) {
      const result = await pool.query(
        `SELECT data
         FROM cineflow_projects
         WHERE id = $1
         LIMIT 1`,
        [projectId]
      );

      if (result.rows.length > 0) {
        project = result.rows[0].data;

        if (project && project.id === projectId) {
          projects.unshift(project);
        } else {
          project = null;
        }
      }
    }
  }

  if (!project) {
    return {
      success: false,
      permanent: true,
      error:
        "Projet introuvable dans la mémoire et dans Neon. Vérifie la sauvegarde du projet."
    };
  }
  

  const scene = (project.scenes || []).find(
    (item) => Number(item.number) === Number(sceneNumber)
  );

  const imageRecord = (project.images || []).find(
    (item) =>
      Number(item.scene) === Number(sceneNumber) &&
      item.status === "generated"
  );

  const imageData = imageRecord?.id
  ? await getImageData(imageRecord.id)
  : null;

  
  if (!scene || !imageData?.data) {
    return {
      success: false,
      permanent: true,
      error:
        "Scène ou image introuvable en mémoire et dans Neon. Vérifie ou regénère l'image avant de relancer."
    };
  }


  const videoId = makeId("video");

  const projectVideo = {
    id: videoId,
    scene: Number(sceneNumber),
    status: "processing",
    provider: "magic-hour"
  };

  if (!Array.isArray(project.videos)) {
    project.videos = [];
  }

  project.videos = project.videos.filter(
    (item) => Number(item.scene) !== Number(sceneNumber)
  );

  project.videos.push(projectVideo);

  project.videos.sort(
    (a, b) => Number(a.scene) - Number(b.scene)
  );

  project.status = "animation_processing";

  generatedVideos.set(videoId, {
    id: videoId,
    projectId: project.id,
    scene: Number(sceneNumber),
    provider: "magic-hour",
    status: "processing"
  });

  await saveProjectToDatabase(project);

  animateVideoWithFallback(
    videoId,
    project,
    scene,
    imageData
  ).catch(async (error) => {
    const message = error?.message || "Erreur vidéo inattendue.";
    const video = generatedVideos.get(videoId);

    if (video) {
      video.status = "error";
      video.error = message;
      generatedVideos.set(videoId, video);
    }

    projectVideo.status = "error";
    projectVideo.error = message;

    await saveProjectToDatabase(project);

    if (botsRouter?.enqueueRecoveryTask) {
      await botsRouter.enqueueRecoveryTask({
        projectId: project.id,
        sceneNumber: Number(sceneNumber),
        videoId,
        error: message
      });
    }
  });

  return {
    success: true,
    videoId
  };
}
/* =========================================================
   HELPERS
========================================================= */

function makeId(prefix) {
  return (
    prefix +
    "_" +
    Date.now() +
    "_" +
    Math.random().toString(36).slice(2, 8)
  );
}
async function followVideoOperation(
  videoId
) {
  const video =
    generatedVideos.get(videoId);

  if (!video) {
    return;
  }

  try {
    let operation =
      video.operation;

    console.log(
      `⏳ Suivi Veo scène ${video.scene}...`
    );

    while (!operation.done) {
      await new Promise(
        (resolve) =>
          setTimeout(resolve, 10000)
      );

      operation =
        await ai.operations.getVideosOperation({
          operation
        });

      video.operation =
        operation;

      generatedVideos.set(
        videoId,
        video
      );

      console.log(
        `⏳ Scène ${video.scene}: ${
          operation.done
            ? "terminée"
            : "encore en cours"
        }`
      );
    }

    if (operation.error) {
      throw new Error(
        operation.error.message ||
        "Veo a échoué."
      );
    }

    const generatedVideo =
      operation.response
        ?.generatedVideos?.[0];

    if (
      !generatedVideo ||
      !generatedVideo.video
    ) {
      throw new Error(
        "Veo a terminé mais aucune vidéo n'a été retournée."
      );
    }

    const outputPath =
      path.join(
        os.tmpdir(),
        `${videoId}.mp4`
      );

    await ai.files.download({
      file:
        generatedVideo.video,

      downloadPath:
        outputPath
    });

   
    video.status = "ready";
    video.filePath = outputPath;
    video.operation = operation;

    generatedVideos.set(videoId, video);

    const project = projects.find(
      (item) => item.id === video.projectId
    );

    if (project && Array.isArray(project.videos)) {
      const projectVideo = project.videos.find(
        (item) => item.id === videoId
      );

      if (projectVideo) {
        projectVideo.status = "ready";
        projectVideo.filePath = outputPath;
        projectVideo.provider = "veo";
      }

      try {
        await saveProjectToDatabase(project);
      } catch (saveError) {
        console.error(
          "Vidéo prête, mais sauvegarde du projet échouée :",
          saveError.message
        );
      }

      try {
        if (botsRouter?.updateRecoveryTask) {
          await botsRouter.updateRecoveryTask({
            projectId: project.id,
            sceneNumber: Number(video.scene),
            status: "completed",
            videoId
          });
        }
      } catch (queueError) {
        console.error(
          "Vidéo prête, mais mise à jour de la file échouée :",
          queueError.message
        );
      }
    }

    console.log(
      `✅ MP4 scène ${video.scene} sauvegardé : ${outputPath}`
    );

} catch (error) {
  video.status = "error";
  video.error = error.message || "Erreur Veo inconnue.";

  generatedVideos.set(videoId, video);

  const project = projects.find(
    item => item.id === video.projectId
  );

  if (project) {
    const projectVideo = project.videos?.find(
      item => item.id === videoId
    );

    if (projectVideo) {
      projectVideo.status = "error";
      projectVideo.error = video.error;
    }

    await saveProjectToDatabase(project);
  }

  if (botsRouter?.enqueueRecoveryTask) {
    await botsRouter.enqueueRecoveryTask({
      projectId: video.projectId,
      sceneNumber: Number(video.scene),
      videoId,
      error: video.error
    });
  }

  console.error(
    `❌ Erreur vidéo scène ${video.scene}:`,
    video.error
  );
  }
        }
function cleanJson(text) {
  if (!text) return null;

  let value = String(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first !== -1 && last !== -1) {
    value = value.slice(first, last + 1);
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getText(result) {
  try {
    return (
      result?.text ||
      result?.response?.text ||
      result?.output_text ||
      result?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("") ||
      ""
    );
  } catch {
    return "";
  }
}

async function generateText(prompt) {
  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY n'est pas configurée sur Render."
    );
  }

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: prompt
  });

  return getText(result);
}

/* =========================================================
   IMAGE GENERATION
========================================================= */


async function generateImage(prompt) {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) {
    throw new Error(
      "Configuration Cloudflare manquante dans Render."
    );
  }

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "1024");
  form.append("height", "576");

  const url =
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`
    },
    body: form
  });

  const result = await response.json();

  if (!response.ok || !result.success || !result.result?.image) {
    const message =
      result.errors?.map(e => e.message).join("; ") ||
      "Cloudflare n'a pas retourné d'image.";

    throw new Error(message);
  }

    return {
    mimeType: "image/png",
    data: result.result.image
  };
}

/* =========================================================
   FFMPEG
========================================================= */

function saveImageFile(imageData) {
  const fileName = makeId("cineflow") + ".png";
  const filePath = path.join(os.tmpdir(), fileName);

  fs.writeFileSync(
    filePath,
    Buffer.from(imageData, "base64")
  );

  return filePath;
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      args,
      {
        maxBuffer: 20 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(stderr || error.message)
          );
          return;
        }

        resolve({
          stdout,
          stderr
        });
      }
    );
  });
}

async function convertVideoFormat(
  input,
  output,
  width,
  height
) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "scale=" +
      width +
      ":" +
      height +
      ":force_original_aspect_ratio=decrease,pad=" +
      width +
      ":" +
      height +
      ":(ow-iw)/2:(oh-ih)/2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output
  ]);
}

/* =========================================================
   PROJECT
========================================================= */

function createProject(data) {
  return {
    id: makeId("project"),

    title:
      data.title ||
      "Nouveau projet",

    prompt:
      data.prompt ||
      "",

    category:
      data.category ||
      "Film",

    status: "created",

    progress: 0,

    createdAt:
      new Date().toISOString(),

    concept: "",

    style: "",

    characters: [],

    scenes: [],

    images: [],

    videos: [],

    finalVideo: null,

    formats: {},

    audio: null,

    thumbnail: null,

    social: {},

    autopilot: false
  };
}

/* =========================================================
   HOSTING MONITOR
========================================================= */

app.get(
  "/api/hosting",
  async (req, res) => {
    const start = Date.now();

    let geminiStatus = false;
    let geminiMessage =
      "Clé Gemini absente.";

    if (API_KEY) {
      geminiStatus = true;
      geminiMessage =
        "Clé Gemini détectée.";
    }

    const responseTime =
      Date.now() - start;

    res.json({
      success: true,

      hosting: {
        provider: "Render",
        status: "online",
        server: "online",
        port: PORT,
        responseTime,
        uptime:
          Math.round(process.uptime()),
        node:
          process.version
      },

      gemini: {
        configured:
          !!API_KEY,

        status:
          geminiStatus
            ? "configured"
            : "missing",

        message:
          geminiMessage,

        textModel:
          MODEL,

        imageModel:
          IMAGE_MODEL,

        videoModel:
          VIDEO_MODEL
      },

      checkedAt:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cineflow: true,
    gemini: !!API_KEY,
    model: MODEL,
    imageModel: IMAGE_MODEL,
    videoModel: VIDEO_MODEL,
    uptime:
      Math.round(process.uptime())
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,

    geminiConnected:
      !!API_KEY,

    message: API_KEY
      ? "Cineflow est connecté à Gemini."
      : "GEMINI_API_KEY manquante."
  });
});

/* =========================================================
   TEST GEMINI
========================================================= */

app.get(
  "/api/test-gemini",
  async (req, res) => {
    const start = Date.now();

    try {
      const text =
        await generateText(
          "Réponds très brièvement en français et confirme que Gemini est connecté à Cineflow."
        );

      res.json({
        success: true,

        responseTime:
          Date.now() - start,

        message:
          text ||
          "Gemini est connecté à Cineflow."
      });

    } catch (error) {
      res.status(500).json({
        success: false,

        responseTime:
          Date.now() - start,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   TEST MAGIC HOUR : ANIMER UNE SEULE SCENE
========================================================= */

app.post("/api/magic-hour/test-scene", async (req, res) => {
  const apiKey = process.env.MAGIC_HOUR_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      success: false,
      error: "MAGIC_HOUR_API_KEY manquante dans Render."
    });
  }

  let inputPath;

  try {
    const project = projects.find(
      (p) => p.id === req.body.projectId
    );

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Projet introuvable."
      });
    }

    const sceneNumber = Number(req.body.sceneNumber);
    const scene = project.scenes?.find(
      (s) => Number(s.number) === sceneNumber
    );

    const imageRecord = project.images?.find(
      (img) => Number(img.scene) === sceneNumber
    );

    const imageData = imageRecord?.id
      ? generatedImages.get(imageRecord.id)
      : null;

    if (!scene || !imageData?.data) {
      return res.status(400).json({
        success: false,
        error: "Scène ou image introuvable. Choisis une scène dont l'image est déjà générée."
      });
    }

    const videoId = makeId("magicvideo");
    const outputDir = path.join(
      os.tmpdir(),
      "cineflow-magic-hour",
      videoId
    );

    fs.mkdirSync(outputDir, { recursive: true });

    inputPath = path.join(
      outputDir,
      "source.png"
    );

    fs.writeFileSync(
      inputPath,
      Buffer.from(imageData.data, "base64")
    );

    const client = new Client({ token: apiKey });

    const result = await client.v1.imageToVideo.generate(
      {
        name: `Cineflow scène ${sceneNumber}`,
        endSeconds: 5,
        resolution: "480p",
        assets: {
          imageFilePath: inputPath
        },
        style: {
          prompt:
            scene.videoPrompt ||
            scene.description ||
            "Mouvement cinématographique naturel, caméra fluide."
        }
      },
      {
        waitForCompletion: true,
        downloadOutputs: true,
        downloadDirectory: outputDir
      }
    );

    const downloadedPaths =
      result.downloadedPaths ||
      result.downloaded_paths ||
      [];

    const videoPath = downloadedPaths.find(
      (file) =>
        typeof file === "string" &&
        /\.(mp4|webm|mov)$/i.test(file)
    );

    if (
      !videoPath ||
      !fs.existsSync(videoPath)
    ) {
      console.error(
        "Résultat Magic Hour sans fichier local :",
        JSON.stringify({
          id: result.id,
          status: result.status
        })
      );

      return res.status(502).json({
        success: false,
        error: "La tâche Magic Hour a répondu, mais le fichier vidéo local est introuvable. Consulte les logs Render."
      });
    }

    generatedVideos.set(videoId, {
      id: videoId,
      projectId: project.id,
      scene: sceneNumber,
      provider: "magic-hour",
      status: "ready",
      filePath: videoPath
    });

    return res.json({
      success: true,
      provider: "magic-hour",
      status: "ready",
      scene: sceneNumber,
      videoId,
      previewUrl: `/api/magic-hour/preview/${videoId}`
    });
  } catch (error) {
    console.error(
      "Erreur test Magic Hour :",
      error.message
    );

    return res.status(502).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/magic-hour/preview/:id", (req, res) => {
  const video = generatedVideos.get(req.params.id);

  if (
    !video ||
    video.provider !== "magic-hour" ||
    video.status !== "ready" ||
    !video.filePath ||
    !fs.existsSync(video.filePath)
  ) {
    return res.status(404).json({
      success: false,
      error: "Vidéo de test introuvable sur cette instance."
    });
  }

  return res.sendFile(video.filePath);
});

app.post("/api/tts/test-scene", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "La clé GEMINI_API_KEY est absente sur Render."
      });
    }

    const language = req.body.language === "en" ? "en" : "fr";

    const dialogues = Array.isArray(req.body.dialogues)
      ? req.body.dialogues
          .filter(d => d && typeof d.text === "string" && d.text.trim())
          .slice(0, 12)
      : [];

    if (dialogues.length === 0) {
      return res.status(400).json({
        error: "Aucun dialogue disponible pour cette scène."
      });
    }

    const speakers = [
      ...new Set(
        dialogues.map((d, i) => String(d.speaker || `Personnage ${i + 1}`))
      )
    ].slice(0, 2);

    const content = dialogues.map((d, i) => ({
      type: "text",
      text: d.text.trim(),
      annotations: [{
        type: "speech_metadata",
        speaker: speakers.includes(String(d.speaker || `Personnage ${i + 1}`))
          ? String(d.speaker || `Personnage ${i + 1}`)
          : speakers[0],
        style: String(d.emotion || "natural, expressive cinematic dialogue")
      }]
    }));

    const interaction = await ai.interactions.create({
      model: "gemini-3.8-flash-tts",
      input: [{
        type: "user_input",
        content
      }],
      
      response_format: { type: "audio" },
      generation_config: {
        speech_config: {
          speakers: [
            { speaker: speakers[0], voice: "Kore" },
            ...(speakers[1]
              ? [{ speaker: speakers[1], voice: "Puck" }]
              : [])
          ]
        }
      }

    });

    const audioBase64 = interaction.output_audio?.data;

    if (!audioBase64) {
      throw new Error("Aucun fichier audio reçu de Gemini.");
    }

    res.json({
      success: true,
      language,
      mimeType: "audio/wav",
      audioBase64
    });
  } catch (error) {
    console.error("Erreur Gemini TTS :", error);
    res.status(500).json({
      error: error.message || "Échec de la génération vocale."
    });
  }
});

app.post("/api/tts/generate-project", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "GEMINI_API_KEY absente sur Render."
      });
    }

   let project = projects.find(
  item => item.id === req.body.projectId
);

if (!project && pool) {
  const ready = await databaseReady;

  if (ready) {
    const result = await pool.query(
      `SELECT data
       FROM cineflow_projects
       WHERE id = $1
       LIMIT 1`,
      [req.body.projectId]
    );

    if (result.rows.length > 0) {
      project = result.rows[0].data;

      if (project && project.id === req.body.projectId) {
        projects.unshift(project);
      } else {
        project = null;
      }
    }
  }
}

if (!project) {
  return res.status(404).json({
    success: false,
    error: "Projet introuvable dans la mémoire et dans Neon."
  });
} 

    if (!Array.isArray(project.scenes) || project.scenes.length !== 5) {
      return res.status(400).json({
        success: false,
        error: "Le projet doit contenir exactement 5 scènes."
      });
    }

    const audioDir = path.join(
      os.tmpdir(),
      "cineflow-audio-" + String(project.id).replace(/[^a-zA-Z0-9_-]/g, "_")
    );

    fs.mkdirSync(audioDir, { recursive: true });

    const tracks = [];

    for (let i = 0; i < project.scenes.length; i++) {
      const scene = project.scenes[i];

      const dialogues = Array.isArray(scene.dialogues)
        ? scene.dialogues
            .filter(d => d && typeof d.text === "string" && d.text.trim())
            .slice(0, 12)
        : [];

      if (dialogues.length === 0) {
        throw new Error(
          "Aucun dialogue dans la scène " + (i + 1) +
          ". Regénère d'abord le scénario."
        );
      }

      const speakers = [
        ...new Set(
          dialogues.map((d, j) =>
            String(d.speaker || "Personnage " + (j + 1))
          )
        )
      ].slice(0, 2);

      const content = dialogues.map((d, j) => ({
        type: "text",
        text: d.text.trim(),
        annotations: [{
          type: "speech_metadata",
          speaker: speakers.includes(
            String(d.speaker || "Personnage " + (j + 1))
          )
            ? String(d.speaker || "Personnage " + (j + 1))
            : speakers[0],
          style: String(d.emotion || "natural, expressive cinematic dialogue")
        }]
      }));

      const interaction = await ai.interactions.create({
        model: "gemini-3.8-flash-tts",
        input: [{ type: "user_input", content }],
        
        response_format: { type: "audio" },
        generation_config: {
          speech_config: {
            speakers: [
              { speaker: speakers[0], voice: "Kore" },
              ...(speakers[1]
                ? [{ speaker: speakers[1], voice: "Puck" }]
                : [])
            ]
          }
        }

      });

      const audioBase64 = interaction.output_audio?.data;

      if (!audioBase64) {
        throw new Error(
          "Gemini n'a pas fourni l'audio de la scène " + (i + 1)
        );
      }

      const filePath = path.join(audioDir, `scene-${i + 1}.wav`);

      fs.writeFileSync(filePath, Buffer.from(audioBase64, "base64"));

      tracks.push({
        sceneNumber: i + 1,
        filePath,
        status: "ready"
      });
    }

    project.audio = {
      status: "ready",
      type: "dialogue",
      tracks
    };
await saveProjectToDatabase(project);
    return res.json({
      success: true,
      message: "Voix générées pour les 5 scènes.",
      tracks: tracks.map(track => ({
        sceneNumber: track.sceneNumber,
        status: track.status
      }))
    });
  } catch (error) {
    console.error("Erreur génération audio du projet :", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Échec de génération des voix."
    });
  }
});

/* =========================================================
   CREATE PROJECT
========================================================= */

app.post(
  "/api/project",
  async (req, res) => {
    try {
      const prompt =
        req.body.prompt;

      const category =
        req.body.category;

      const title =
        req.body.title;

      if (!prompt) {
        return res.status(400).json({
          error:
            "Décris ton idée de vidéo."
        });
      }

      const project =
        createProject({
          prompt,
          category,
          title
        });

      project.status =
        "generating";

      project.progress = 10;

    
const text =
  await generateText(
    [
      "Tu es le scénariste principal de Cineflow, spécialisé dans les films cinématographiques.",
      "",
      "Crée un scénario détaillé à partir de cette idée :",
      prompt,
      "",
      "Catégorie :",
      category || "Film",
      "",
      "LANGUE : tous les dialogues doivent être en français naturel.",
      "",
      "RÈGLES DU SCÉNARIO :",
      "- Retourne exactement 5 scènes, numérotées de 1 à 5.",
      "- Garde les mêmes personnages, noms et personnalités dans tout le film.",
      "- Chaque scène doit faire avancer l'histoire.",
      "- Ajoute entre 3 et 6 répliques naturelles par scène lorsque la situation le permet.",
      "- Chaque réplique doit avoir un personnage qui parle, un texte et une émotion.",
      "- Les dialogues doivent être adaptés au genre, à l'âge des personnages et à la situation.",
      "- Évite les dialogues répétitifs et les phrases artificielles.",
      "- Décris les mouvements, les expressions du visage et les actions des personnages.",
      "- Les prompts vidéo doivent décrire des mouvements réalistes et cohérents.",
      "- Prévois les bruitages adaptés à chaque scène.",
      "- Indique l'ambiance musicale souhaitée, sans inclure de paroles de chansons existantes.",
      "- Les dialogues seront utilisés ultérieurement pour générer les voix : ne les écris pas uniquement dans la description.",
      "",
      "Retourne uniquement un JSON valide, sans Markdown ni commentaire.",
      "Structure obligatoire :",
      JSON.stringify({
        title: "Titre du film",
        concept: "Résumé de l'histoire",
        style: "Style visuel et ambiance",
        characters: [
          {
            name: "Nom du personnage",
            description: "Apparence et rôle",
            personality: "Personnalité",
            voiceDescription: "Voix française, ton et manière de parler"
          }
        ],
        scenes: [
          {
            number: 1,
            title: "Titre de la scène",
            description: "Description détaillée de l'action",
            imagePrompt: "Prompt détaillé de l'image cinématographique",
            videoPrompt: "Prompt détaillé des mouvements et actions",
            dialogues: [
              {
                speaker: "Nom exact du personnage",
                text: "Réplique en français",
                emotion: "Émotion à exprimer"
              }
            ],
            soundEffects: [
              "Bruitages adaptés à la scène"
            ],
            musicMood: "Ambiance musicale souhaitée"
          }
        ]
      }, null, 2),
      "",
      "Le tableau scenes doit contenir exactement 5 objets.",
      "Chaque scène doit avoir ses propres dialogues, soundEffects et musicMood.",
      "Chaque speaker doit correspondre à un personnage déclaré dans characters.",
      "Pour dialogues, crée plusieurs répliques distinctes par scène, sans inventer de nouveaux personnages inutilement."
    ].join("\n")
  );


      const data =
        cleanJson(text);

      if (!data) {
        throw new Error(
          "Gemini n'a pas retourné un JSON exploitable."
        );
      }

      project.title =
        data.title ||
        project.title;

      project.concept =
        data.concept || "";

      project.style =
        data.style || "";

      project.characters =
        Array.isArray(data.characters)
          ? data.characters
          : [];

      project.scenes =
        Array.isArray(data.scenes)
          ? data.scenes.slice(0, 5)
          : [];

      project.progress = 30;
      project.status = "ready";

if (pool) {
  await pool.query(
    `INSERT INTO cineflow_projects (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data,
                   updated_at = NOW()`,
    [project.id, JSON.stringify(project)]
  );
}

      projects.unshift(project);

      res.json({
        success: true,
        project
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   PROJECTS
========================================================= */

app.delete("/api/project/:id", async (req, res) => {
  const id = req.params.id;

  try {
    if (pool) {
      await databaseReady;

      const result = await pool.query(
        "DELETE FROM cineflow_projects WHERE id = $1",
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error: "Projet introuvable."
        });
      }
    } else {
      const index = projects.findIndex(
        project => project.id === id
      );

      if (index === -1) {
        return res.status(404).json({
          success: false,
          error: "Projet introuvable."
        });
      }
    }

    const index = projects.findIndex(
      project => project.id === id
    );

    if (index !== -1) {
      projects.splice(index, 1);
    }

    for (const [key, job] of jobs) {
      if (job.projectId === id) {
        jobs.delete(key);
      }
    }

    for (const [key, image] of generatedImages) {
      if (image.projectId === id) {
        generatedImages.delete(key);
      }
    }

    for (const [key, video] of generatedVideos) {
      if (video.projectId === id) {
        generatedVideos.delete(key);
      }
    }

    return res.json({
      success: true,
      message: "Projet supprimé."
    });
  } catch (error) {
    console.error("Suppression projet :", error.message);

    return res.status(500).json({
      success: false,
      error: "Impossible de supprimer le projet."
    });
  }
});

app.get("/api/projects", async (req, res) => {
  try {
    if (pool) {
      await databaseReady;

      const result = await pool.query(
        "SELECT data FROM cineflow_projects ORDER BY updated_at DESC"
      );

      const savedProjects = result.rows.map(row => row.data);

      for (const saved of savedProjects) {
        const index = projects.findIndex(
          project => project.id === saved.id
        );

        if (index === -1) {
          projects.push(saved);
        } else {
          projects[index] = saved;
        }
      }

      return res.json({
        success: true,
        projects: savedProjects
      });
    }

    return res.json({
      success: true,
      projects
    });
  } catch (error) {
    console.error("Erreur de lecture Neon :", error.message);

    return res.status(500).json({
      success: false,
      error: "Impossible de récupérer les projets."
    });
  }
});

app.get("/api/project/:id", async (req, res) => {
  try {
    let project = projects.find(
      item => item.id === req.params.id
    );

    if (pool) {
      await databaseReady;

      const result = await pool.query(
        "SELECT data FROM cineflow_projects WHERE id = $1",
        [req.params.id]
      );

      if (result.rows.length > 0) {
        project = result.rows[0].data;

        const index = projects.findIndex(
          item => item.id === project.id
        );

        if (index === -1) {
          projects.push(project);
        } else {
          projects[index] = project;
        }
      }
    }

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Projet introuvable."
      });
    }

    return res.json({
      success: true,
      project
    });
  } catch (error) {
    console.error("Erreur de lecture du projet :", error.message);

    return res.status(500).json({
      success: false,
      error: "Impossible de récupérer ce projet."
    });
  }
});

/* =========================================================
   SCENES
========================================================= */

app.post(
  "/api/scenes",
  (req, res) => {
    const project =
      projects.find(
        (item) =>
          item.id ===
          req.body.projectId
      );

    if (!project) {
      return res.status(404).json({
        error:
          "Projet introuvable."
      });
    }

    project.status =
      "scenes_ready";

    project.progress = 40;

    res.json({
      success: true,
      scenes:
        project.scenes
    });
  }
);

/* =========================================================
   IMAGES
========================================================= */

app.post(
  "/api/images",
  async (req, res) => {
    try {
      const project =
        projects.find(
          (item) =>
            item.id ===
            req.body.projectId
        );

      if (!project) {
        return res.status(404).json({
          error:
            "Projet introuvable."
        });
      }

      if (!project.scenes.length) {
        return res.status(400).json({
          error:
            "Aucune scène disponible."
        });
      }

      const results = [];

      for (
        let i = 0;
        i < project.scenes.length;
        i++
      ) {
        const scene =
          project.scenes[i];

        try {
          const image =
            await generateImage(
              [
                "Crée une image cinématographique premium pour Cineflow.",
                "",
                "Scène :",
                scene.description || "",
                "",
                "Direction visuelle :",
                scene.imagePrompt || "",
                "",
                "Style :",
                project.style ||
                  "cinématographique",
                "",
                "Personnages cohérents avec l'histoire.",
                "Composition professionnelle.",
                "Éclairage cinématographique.",
                "Format 16:9.",
                "Aucune interface, aucun texte, aucun logo."
              ].join("\n")
            );

          const imageId =
            makeId("image");

          
          const imageRecord = {
  id: imageId,
  projectId: project.id,
  scene: scene.number,
  mimeType: image.mimeType,
  data: image.data
};

         
generatedImages.set(imageId, imageRecord);
await saveImageToDatabase(imageId, imageRecord);
 
          results.push({
            id: imageId,
            scene:
              scene.number,
            status:
              "generated",
            url:
              "/api/image/" +
              imageId
          });

        } catch (error) {
          results.push({
            scene:
              scene.number,
            status:
              "error",
            error:
              error.message
          });
        }

        project.progress =
          45 +
          Math.round(
            ((i + 1) /
              project.scenes.length) *
              20
          );
      }

      project.images =
        results;

      project.status =
        results.some(
          (item) =>
            item.status ===
            "generated"
        )
          ? "images_ready"
          : "images_error";
      await 
  saveProjectToDatabase(project);
      res.json({
        success:
          results.some(
            (item) =>
              item.status ===
              "generated"
          ),

        images:
          results,

        project
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   SERVE IMAGE
========================================================= */
app.get(
  "/api/image/:id",
  async (req, res) => {
    try {
      const image = await getImageData(
        req.params.id
      );

      if (!image?.data) {
        return res.status(404).json({
          error: "Image introuvable dans la mémoire et dans Neon."
        });
      }

      res.setHeader(
        "Content-Type",
        image.mimeType || "image/png"
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=3600"
      );

      res.send(
        Buffer.from(image.data, "base64")
      );
    } catch (error) {
      console.error(
        "Erreur de récupération de l'image :",
        error.message
      );

      res.status(500).json({
        error: "Impossible de récupérer l'image."
      });
    }
  }
);

/* =========================================================
   PROJECT IMAGES
========================================================= */

app.get(
  "/api/project/:id/images",
  (req, res) => {
    const project =
      projects.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!project) {
      return res.status(404).json({
        error:
          "Projet introuvable."
      });
    }

    res.json({
      success: true,

      images:
        project.images.map(
          (image) => ({
            ...image,

            url:
              image.id
                ? "/api/image/" +
                  image.id
                : null
          })
        )
    });
  }
);

/* =========================================================
   REGENERATE SCENE
========================================================= */

app.post(
  "/api/regenerate-scene",
  async (req, res) => {
    try {
      const project =
        projects.find(
          (item) =>
            item.id ===
            req.body.projectId
        );

      if (!project) {
        return res.status(404).json({
          error:
            "Projet introuvable."
        });
      }

      const scene =
        project.scenes.find(
          (item) =>
            Number(item.number) ===
            Number(
              req.body.sceneNumber
            )
        );

      if (!scene) {
        return res.status(404).json({
          error:
            "Scène introuvable."
        });
      }

      const image =
        await generateImage(
          [
            "Crée une nouvelle version premium de cette scène.",
            "",
            scene.description || "",
            "",
            scene.imagePrompt || "",
            "",
            "Style :",
            project.style ||
              "cinématographique",
            "",
            "Même univers visuel.",
            "Même personnages.",
            "Nouvelle composition.",
            "Format 16:9.",
            "Aucun texte ni logo."
          ].join("\n")
        );

      const imageId =
        makeId("image");

      generatedImages.set(
        imageId,
        {
          id: imageId,
          projectId:
            project.id,
          scene:
            scene.number,
          mimeType:
            image.mimeType,
          data:
            image.data
        }
      );
          await saveImageToDatabase(
            imageId,
            generatedImages.get(imageId)
          );
      project.images =
        project.images.filter(
          (item) =>
            Number(item.scene) !==
            Number(scene.number)
        );

      project.images.push({
        id: imageId,
        scene:
          scene.number,
        status:
          "generated",
        url:
          "/api/image/" +
          imageId
      });
      await saveProjectToDatabase(project);
      res.json({
        success: true,

        image: {
          id: imageId,

          scene:
            scene.number,

          url:
            "/api/image/" +
            imageId
        }
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);


/* =========================================================
   ANIMATION : MAGIC HOUR EN PREMIER, VEO EN SECOURS
========================================================= */

async function animateVideoWithFallback(videoId, project, scene, imageData) {
  const video = generatedVideos.get(videoId);
  const projectVideo = (project.videos || []).find(
    (item) => item.id === videoId
  );

  if (!video || !projectVideo) return;

  const apiKey = process.env.MAGIC_HOUR_API_KEY;
  let magicHourError = "Clé Magic Hour absente.";

  // 1. PRIORITÉ : MAGIC HOUR
  if (apiKey) {
    try {
      const outputDir = path.join(
        os.tmpdir(),
        "cineflow-magic-hour",
        videoId
      );

      fs.mkdirSync(outputDir, { recursive: true });

      const inputPath = path.join(outputDir, "source.png");

      fs.writeFileSync(
        inputPath,
        Buffer.from(imageData.data, "base64")
      );

      console.log(
        `🎬 Scène ${scene.number} : tentative Magic Hour.`
      );

      const client = new Client({ token: apiKey });

      const result = await client.v1.imageToVideo.generate(
        {
          name: `Cineflow scène ${scene.number}`,
          endSeconds: 5,
          resolution: "480p",
          assets: {
            imageFilePath: inputPath
          },
          style: {
            prompt:
              scene.videoPrompt ||
              scene.description ||
              "Mouvement cinématographique naturel, caméra fluide."
          }
        },
        {
          waitForCompletion: true,
          downloadOutputs: true,
          downloadDirectory: outputDir
        }
      );

      const downloadedPaths =
        result.downloadedPaths ||
        result.downloaded_paths ||
        [];

      const videoPath = downloadedPaths.find(
        (file) =>
          typeof file === "string" &&
          /\.(mp4|webm|mov)$/i.test(file)
      );

      if (!videoPath || !fs.existsSync(videoPath)) {
        throw new Error(
          "Magic Hour n'a pas fourni de fichier vidéo local."
        );
      }

      video.status = "ready";
      video.provider = "magic-hour";
      video.filePath = videoPath;

      projectVideo.status = "ready";
      projectVideo.provider = "magic-hour";
      projectVideo.filePath = videoPath;

      generatedVideos.set(videoId, video);

      await saveProjectToDatabase(project);
if (botsRouter?.updateRecoveryTask) {
  await botsRouter.updateRecoveryTask({
    projectId: project.id,
    sceneNumber: Number(scene.number),
    status: "completed",
    videoId
  });
}
      console.log(
        `✅ Scène ${scene.number} terminée avec Magic Hour.`
      );

      return;

    } catch (error) {
      magicHourError =
        error.message || "Erreur Magic Hour inconnue.";

      console.error(
        `⚠️ Magic Hour a échoué pour la scène ${scene.number} :`,
        magicHourError
      );
    }
  }

  // 2. SECOURS : VEO
  try {
    if (!ai) {
      throw new Error(
        "GEMINI_API_KEY manquante : Veo ne peut pas démarrer."
      );
    }

    console.log(
      `🎬 Scène ${scene.number} : tentative Veo.`
    );

    const operation = await ai.models.generateVideos({
      model: VIDEO_MODEL,
      prompt:
        scene.videoPrompt ||
        scene.description ||
        "Cinematic scene.",
      image: {
        imageBytes: imageData.data,
        mimeType: imageData.mimeType || "image/png"
      },
      config: {
        aspectRatio: "16:9"
      }
    });

    video.operation = operation;
    video.provider = "veo";
    video.status = "processing";

    projectVideo.provider = "veo";
    projectVideo.status = "processing";

    generatedVideos.set(videoId, video);

    await saveProjectToDatabase(project);

    followVideoOperation(videoId);

    console.log(
      `⏳ Scène ${scene.number} envoyée à Veo.`
    );

  } catch (error) {
    video.status = "error";
    video.error =
      "Magic Hour : " + magicHourError +
      " | Veo : " + (error.message || "échec inconnu");

    projectVideo.status = "error";
    projectVideo.error = video.error;

    generatedVideos.set(videoId, video);

    await saveProjectToDatabase(project);
if (botsRouter?.enqueueRecoveryTask) {
  await botsRouter.enqueueRecoveryTask({
    projectId: project.id,
    sceneNumber: Number(scene.number),
    videoId,
    error: video.error
  });
}
    console.error(
      `❌ Échec des deux moteurs pour la scène ${scene.number} :`,
      video.error
    );
  }
}

app.post("/api/animate", async (req, res) => {
  try {
    const project = projects.find(
      (item) => item.id === req.body.projectId
    );

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Projet introuvable."
      });
    }

    if (!project.scenes || project.scenes.length !== 5) {
      return res.status(400).json({
        success: false,
        error: "Le projet doit contenir 5 scènes."
      });
    }

    // Vérifier que les cinq images sont disponibles.
    
    const imageErrors = [];

    const sceneImages = await Promise.all(
      project.scenes.map(async (scene) => {
        const imageRecord = (project.images || []).find(
          (img) =>
            Number(img.scene) === Number(scene.number)
        );

        const imageData =
          imageRecord?.id &&
          imageRecord.status === "generated"
            ? await getImageData(imageRecord.id)
            : null;

        if (!imageData?.data) {
          imageErrors.push(Number(scene.number));
          return null;
        }

        return { scene, imageData };
      })
    );


    if (imageErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error:
          "Images indisponibles pour les scènes : " +
          imageErrors.join(", ") +
          ". Regénère ces images avant de lancer l'animation."
      });
    }

    // Préparer les cinq vidéos avant de lancer les tâches.
    const videos = sceneImages.map(({ scene }) => ({
      id: makeId("video"),
      scene: scene.number,
      status: "processing",
      provider: "magic-hour"
    }));

    project.videos = videos;
    project.status = "animation_processing";
    project.progress = 75;

    await saveProjectToDatabase(project);
    
    // Chaque scène essaie Magic Hour, puis Veo si nécessaire.
    sceneImages.forEach(({ scene, imageData }, index) => {
      const video = videos[index];

      generatedVideos.set(video.id, {
        id: video.id,
        projectId: project.id,
        scene: scene.number,
        provider: "magic-hour",
        status: "processing"
      });

      animateVideoWithFallback(
        video.id,
        project,
        scene,
        imageData
      ).catch(async (error) => {
        const stored = generatedVideos.get(video.id);

        if (stored) {
          stored.status = "error";
          stored.error =
            error.message || "Erreur vidéo inconnue.";

          generatedVideos.set(video.id, stored);
        }

        video.status = "error";
        video.error =
          error.message || "Erreur vidéo inconnue.";

        await saveProjectToDatabase(project);
        if (botsRouter?.enqueueRecoveryTask) {
  await botsRouter.enqueueRecoveryTask({
    projectId: project.id,
    sceneNumber: Number(video.scene),
    videoId: video.id,
    error: video.error
  });
        }
      });
    });

    return res.json({
      success: true,
      videos,
      priority: ["magic-hour", "veo"]
    });

  } catch (error) {
    console.error("Erreur /api/animate :", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/*============================================================
   JOBS
========================================================= */

app.get(
  "/api/jobs",
  (req, res) => {
    res.json({
      success: true,

      jobs:
        Array.from(
          jobs.values()
        )
    });
  }
);

async function buildImageMontage(project, jobId) {
  let job = jobs.get(jobId);

  // Restaurer une tâche manquante si le projet existe encore
  if (!job && project && project.id && jobId) {
    job = {
      id: jobId,
      projectId: project.id,
      type: "image-montage",
      status: "processing",
      progress: 5,
      createdAt: new Date().toISOString()
    };

    jobs.set(jobId, job);

    console.log(
      "Tâche de montage restaurée :",
      jobId
    );
  }

  if (!job) {
    throw new Error(
      "Impossible de restaurer la tâche de montage."
    );
  }

  const outputPath = path.join(
    os.tmpdir(),
    `${jobId}.mp4`
  );

  const concatPath = path.join(
    os.tmpdir(),
    `${jobId}-images.txt`
  );

  const clipPaths = [];

  try {
    
    const images = (project.images || [])
      .filter(
        (img) =>
          img.status === "generated" &&
          img.id
      )
      .sort(
        (a, b) =>
          Number(a.scene) - Number(b.scene)
      );


    if (images.length !== 5) {
      throw new Error("Il faut exactement 5 images.");
    }

    for (let i = 0; i < images.length; i++) {
      const image = await getImageData(images[i].id);

if (!image?.data) {
  throw new Error(
    `Image de la scène ${images[i].scene} introuvable en mémoire et dans Neon.`
  );
}

      const imagePath = saveImageFile(image.data);

      const clipPath = path.join(
        os.tmpdir(),
        `${jobId}-scene-${i + 1}.mp4`
      );

      await runFFmpeg([
        "-y",
        "-loop", "1",
        "-framerate", "25",
        "-i", imagePath,
        "-vf",
        "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=z='min(zoom+0.0015,1.12)':d=125:s=1280x720:fps=25,format=yuv420p",
        "-t", "5",
        "-an",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "25",
        "-pix_fmt", "yuv420p",
        clipPath
      ]);

      clipPaths.push(clipPath);

      job.progress = 10 + (i + 1) * 15;
      jobs.set(jobId, job);
    }

    fs.writeFileSync(
      concatPath,
      clipPaths
        .map((file) => `file '${file}'`)
        .join("\n")
    );

    
    // Créer une ambiance sonore simple selon le genre
    const category = String(
      project.category || "Film"
    ).toLowerCase();

    let notes = [130.81, 164.81, 196];

    if (category.includes("action")) {
      notes = [110, 138.59, 164.81];
    } else if (
      category.includes("drame") ||
      category.includes("drama")
    ) {
      notes = [130.81, 155.56, 196];
    } else if (category.includes("football")) {
      notes = [110, 146.83, 220];
    } else if (category.includes("animation")) {
      notes = [261.63, 329.63, 392];
    }

    const audioExpression =
      `0.08*sin(2*PI*${notes[0]}*t)` +
      `*(0.7+0.3*sin(2*PI*0.12*t))` +
      `+0.04*sin(2*PI*${notes[1]}*t)` +
      `*(0.7+0.3*sin(2*PI*0.09*t))` +
      `+0.02*sin(2*PI*${notes[2]}*t)`;

    try {
      await runFFmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatPath,
        "-f", "lavfi",
        "-i",
        `aevalsrc=${audioExpression}:s=44100:d=25`,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-af",
        "volume=0.5,afade=t=in:st=0:d=2,afade=t=out:st=22:d=3",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "96k",
        "-shortest",
        "-movflags", "+faststart",
        outputPath
      ]);

      console.log("Ambiance sonore ajoutée.");

    } catch (audioError) {
      console.error(
        "Audio indisponible, montage vidéo seul :",
        audioError.message
      );

      await runFFmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatPath,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outputPath
      ]);
    }


    job.status = "ready";
    job.progress = 100;
    job.filePath = outputPath;

    project.status = "ready";
    project.progress = 100;
    project.finalVideo = {
      path: outputPath,
      jobId,
      createdAt: new Date().toISOString()
    };
    await saveProjectToDatabase(project);
    
    jobs.set(jobId, job);

    console.log("Montage de secours terminé :", outputPath);

  } catch (error) {
    job.status = "error";
    job.error = error.message;
    project.status = "error";

    jobs.set(jobId, job);

    console.error("Erreur montage images :", error);
    throw error;
  }
}
/* =========================================================
 FINAL VIDEO
========================================================= */
app.post(
  "/api/final-video",
  async (req, res) => {
    try {
      const project =
        projects.find(
          (item) =>
            item.id ===
            req.body.projectId
        );

      if (!project) {
        return res.status(404).json({
          error:
            "Projet introuvable."
        });
      }

      // MONTAGE DE SECOURS À PARTIR DES IMAGES
      if (req.body.mode === "images") {
        
const images =
  (project.images || []).filter(
    (img) =>
      img.status === "generated" &&
      img.id
  );


        if (images.length !== 5) {
          return res.status(400).json({
            success: false,
            error:
              "Il faut 5 images disponibles. Images trouvées : " +
              images.length +
              "/5."
          });
        }

        const jobId = makeId("render");

        jobs.set(jobId, {
          id: jobId,
          projectId: project.id,
          type: "image-montage",
          status: "processing",
          progress: 5,
          createdAt: new Date().toISOString()
        });

        project.status = "montage_images";
        project.progress = 5;

        res.json({
          success: true,
          jobId,
          status: "processing",
          mode: "images"
        });

        buildImageMontage(
          project,
          jobId
        ).catch((error) => {
          console.error(
            "Erreur montage de secours :",
            error
          );
        });

        return;
      }

      // VÉRIFIER LES 5 VIDÉOS
      if (
        !project.videos ||
        project.videos.length !== 5
      ) {
        return res.status(400).json({
          error:
            "Les 5 scènes doivent être générées avant le montage."
        });
      }

      const sceneVideos = [];

      for (
        const sceneVideo of project.videos
      ) {
        const video =
          generatedVideos.get(
            sceneVideo.id
          );

        if (
          !video ||
          video.status !== "ready" ||
          !video.filePath
        ) {
          return res.status(400).json({
            error:
              `La vidéo de la scène ${sceneVideo.scene} n'est pas encore prête.`
          });
        }

        if (
          !fs.existsSync(
            video.filePath
          )
        ) {
          return res.status(400).json({
            error:
              `Fichier MP4 manquant pour la scène ${sceneVideo.scene}.`
          });
        }

        sceneVideos.push(video);
      }

      sceneVideos.sort(
        (a, b) =>
          Number(a.scene) -
          Number(b.scene)
      );

      const jobId =
        makeId("render");

      const outputPath =
        path.join(
          os.tmpdir(),
          `${jobId}.mp4`
        );

      const concatList =
        path.join(
          os.tmpdir(),
          `${jobId}.txt`
        );
// Préparer la liste des voix des cinq scènes.
const audioTracks = (project.audio?.tracks || [])
  .slice()
  .sort((a, b) => Number(a.sceneNumber) - Number(b.sceneNumber));

if (
  audioTracks.length !== 5 ||
  audioTracks.some(
    (track, index) =>
      Number(track.sceneNumber) !== index + 1 ||
      !track.filePath ||
      !fs.existsSync(track.filePath)
  )
) {
  return res.status(400).json({
    success: false,
    error:
      "Les cinq pistes vocales ne sont pas disponibles. Génère d'abord les voix du projet."
  });
}

const audioConcatList = path.join(
  os.tmpdir(),
  `${jobId}-audio.txt`
);

fs.writeFileSync(
  audioConcatList,
  audioTracks
    .map(
      track =>
        `file '${track.filePath.replace(/'/g, "'\\''")}'`
    )
    .join("\n")
);
      fs.writeFileSync(
        concatList,
        sceneVideos
          .map(
            (video) =>
              `file '${video.filePath.replace(/'/g, "'\\''")}'`
          )
          .join("\n")
      );

      jobs.set(jobId, {
        id: jobId,
        projectId: project.id,
        type: "final-video",
        status: "processing",
        progress: 90,
        createdAt: new Date().toISOString()
      });

      project.status = "montage";
      project.progress = 90;

      res.json({
        success: true,
        jobId,
        status: "processing"
      });

      
      execFile(
        ffmpegPath,
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          concatList,
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          audioConcatList,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          outputPath
        ],
        async (error) => {
          const job = jobs.get(jobId);

          if (!job) {
            return;
          }

          if (error) {
            console.error(
              "❌ Erreur FFmpeg :",
              error
            );

            job.status = "error";
            job.error = error.message;
            project.status = "error";

            jobs.set(jobId, job);
            await saveProjectToDatabase(project);
            return;
          }

          job.status = "ready";
          job.progress = 100;
          job.filePath = outputPath;

          project.status = "ready";
          project.progress = 100;

          project.finalVideo = {
            path: outputPath,
            jobId,
            createdAt: new Date().toISOString()
          };

          await saveProjectToDatabase(project);
          jobs.set(jobId, job);

          console.log(
            `🎬 Film final créé : ${outputPath}`
          );
        }
      );


    } catch (error) {
      console.error(
        "Erreur /api/final-video :",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    }
  }
);

/* =========================================================
   FINAL VIDEO FILE
========================================================= */

app.get(
  "/api/final-video/:projectId",
  (req, res) => {
    const project =
      projects.find(
        (item) =>
          item.id ===
          req.params.projectId
      );

    if (!project) {
      return res.status(404).json({
        error:
          "Projet introuvable."
      });
    }

    if (
      !project.finalVideo ||
      !project.finalVideo.path
    ) {
      return res.status(404).json({
        error:
          "La vidéo finale n'est pas encore disponible."
      });
    }

    if (
      !fs.existsSync(
        project.finalVideo.path
      )
    ) {
      return res.status(404).json({
        error:
          "Fichier vidéo final introuvable."
      });
    }

    res.sendFile(
      project.finalVideo.path
    );
  }
);
/* =========================================================
   FORMATS
========================================================= */

app.post(
  "/api/formats",
  (req, res) => {
    const project =
      projects.find(
        (item) =>
          item.id ===
          req.body.projectId
      );

    if (!project) {
      return res.status(404).json({
        error:
          "Projet introuvable."
      });
    }

    project.formats = {
      landscape: {
        name:
          "YouTube",

        ratio:
          "16:9",

        width:
          1920,

        height:
          1080,

        status:
          "ready"
      },

      portrait: {
        name:
          "TikTok / Reels / Shorts",

        ratio:
          "9:16",

        width:
          1080,

        height:
          1920,

        status:
          "ready"
      },

      square: {
        name:
          "Instagram",

        ratio:
          "1:1",

        width:
          1080,

        height:
          1080,

        status:
          "ready"
      }
    };

    res.json({
      success: true,

      formats:
        project.formats
    });
  }
);

/* =========================================================
   AUDIO
========================================================= */

app.post(
  "/api/prepare-audio",
  (req, res) => {
    const project =
      projects.find(
        (item) =>
          item.id ===
          req.body.projectId
      );

    if (!project) {
      return res.status(404).json({
        error:
          "Projet introuvable."
      });
    }

    project.audio = {
      status:
        "prepared",

      type:
        "cinematic",

      message:
        "Piste audio préparée."
    };

    res.json({
      success: true,

      audio:
        project.audio
    });
  }
);

/* =========================================================
   THUMBNAIL
========================================================= */

app.post(
  "/api/thumbnail",
  (req, res) => {
    const project =
      projects.find(
        (item) =>
          item.id ===
          req.body.projectId
      );

    if (!project) {
      return res.status(404).json({
        error:
          "Projet introuvable."
      });
    }

    project.thumbnail = {
      status:
        "prepared",

      title:
        project.title
    };

    res.json({
      success: true,

      thumbnail:
        project.thumbnail
    });
  }
);

/* =========================================================
   SOCIAL
========================================================= */

app.post(
  "/api/social",
  (req, res) => {
    const project =
      projects.find(
        (item) =>
          item.id ===
          req.body.projectId
      );

    if (!project) {
      return res.status(404).json({
        error:
          "Projet introuvable."
      });
    }

    project.social = {
      youtube: {
        status:
          accounts.youtube
            ? "connected"
            : "not_connected"
      },

      tiktok: {
        status:
          accounts.tiktok
            ? "connected"
            : "not_connected"
      },

      instagram: {
        status:
          accounts.instagram
            ? "connected"
            : "not_connected"
      }
    };

    res.json({
      success: true,

      social:
        project.social
    });
  }
);

/* =========================================================
   ACCOUNTS
========================================================= */

app.get(
  "/api/accounts",
  (req, res) => {
    res.json({
      success: true,
      accounts
    });
  }
);

app.post(
  "/api/accounts/connect",
  (req, res) => {
    const platform =
      req.body.platform;

    if (
      !Object.prototype.hasOwnProperty.call(
        accounts,
        platform
      )
    ) {
      return res.status(400).json({
        error:
          "Plateforme inconnue."
      });
    }

    accounts[platform] = true;

    platformStats[platform].connected =
      true;

    res.json({
      success: true,
      accounts,
      stats:
        platformStats
    });
  }
);

/* =========================================================
   REVENUE
========================================================= */

app.get(
  "/api/revenue",
  (req, res) => {
    const platforms =
      Object.keys(
        platformStats
      ).map(
        (name) => ({
          platform:
            name,

          ...platformStats[name]
        })
      );

    const totals =
      platforms.reduce(
        (total, item) => {
          total.views +=
            Number(item.views || 0);

          total.likes +=
            Number(item.likes || 0);

          total.subscribers +=
            Number(
              item.subscribers || 0
            );

          total.revenue +=
            Number(
              item.revenue || 0
            );

          return total;
        },
        {
          views: 0,
          likes: 0,
          subscribers: 0,
          revenue: 0
        }
      );

    res.json({
      success: true,

      currency:
        "USD",

      connected:
        Object.values(accounts)
          .filter(Boolean)
          .length,

      platforms,

      totals,

      message:
        "Les revenus réels seront récupérés après connexion des API officielles des plateformes."
    });
  }
);

/* =========================================================
   UPDATE MANUAL REVENUE DATA
   Utilisé plus tard par les intégrations officielles.
========================================================= */

app.post(
  "/api/revenue/update",
  (req, res) => {
    const platform =
      req.body.platform;

    if (
      !Object.prototype.hasOwnProperty.call(
        platformStats,
        platform
      )
    ) {
      return res.status(400).json({
        error:
          "Plateforme inconnue."
      });
    }

    const values =
      platformStats[platform];

    if (
      req.body.views !== undefined
    ) {
      values.views =
        Number(req.body.views) || 0;
    }

    if (
      req.body.likes !== undefined
    ) {
      values.likes =
        Number(req.body.likes) || 0;
    }

    if (
      req.body.subscribers !== undefined
    ) {
      values.subscribers =
        Number(
          req.body.subscribers
        ) || 0;
    }

    if (
      req.body.revenue !== undefined
    ) {
      values.revenue =
        Number(
          req.body.revenue
        ) || 0;
    }

    res.json({
      success: true,

      platform,

      stats:
        values
    });
  }
);

/* =========================================================
   AUTO PILOTE
========================================================= */

app.post(
  "/api/autopilot",
  async (req, res) => {
    try {
      const prompt =
        req.body.prompt;

      const category =
        req.body.category;

      if (!prompt) {
        return res.status(400).json({
          error:
            "Donne une idée à Cineflow."
        });
      }

      const project =
        createProject({
          prompt,
          category
        });

      project.status =
        "autopilot";

      project.progress = 5;
      project.autopilot = true;

      projects.unshift(project);

      const jobId =
        makeId("autopilot");

      jobs.set(
        jobId,
        {
          id: jobId,

          projectId:
            project.id,

          type:
            "autopilot",

          status:
            "started",

          progress: 5,

          step:
            "Création du scénario",

          createdAt:
            new Date().toISOString()
        }
      );

      res.json({
        success: true,

        project,

        jobId
      });

      try {
        const text =
          await generateText(
            [
              "Crée un projet vidéo complet pour Cineflow.",
              "",
              "Idée :",
              prompt,
              "",
              "Catégorie :",
              category || "Film",
              "",
              "Retourne uniquement un JSON valide avec un titre,",
              "un concept, un style, des personnages et exactement 5 scènes.",
              "",
                            "Chaque scène doit contenir :",
              "number, title, description, imagePrompt, videoPrompt, dialogues, soundEffects, musicMood.",
              "dialogues doit contenir 3 à 6 objets avec speaker, text et emotion.",
              "Chaque dialogue doit être en français naturel et adapté au personnage.",
                            "soundEffects doit décrire les bruitages de la scène.",
              "musicMood doit décrire l'ambiance musicale souhaitée."
            ]
          );

        const data =
          cleanJson(text);

        if (data) {
          project.title =
            data.title ||
            project.title;

          project.concept =
            data.concept || "";

          project.style =
            data.style || "";

          project.characters =
            Array.isArray(
              data.characters
            )
              ? data.characters
              : [];

          project.scenes =
            Array.isArray(
              data.scenes
            )
              ? data.scenes.slice(
                  0,
                  5
                )
              : [];
        }

        project.progress = 30;
        project.status = "ready";

        const job =
          jobs.get(jobId);

        if (job) {
          job.progress = 30;
          job.status = "ready";
          job.step =
            "Scénario terminé";
        }

      } catch (error) {
        project.status =
          "error";

        const job =
          jobs.get(jobId);

        if (job) {
          job.status =
            "error";

          job.error =
            error.message;
        }
      }

    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   AUTOPILOT STATUS
========================================================= */

app.get(
  "/api/autopilot/:id",
  (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res.status(404).json({
        error:
          "Job Auto-Pilote introuvable."
      });
    }

    const project =
      projects.find(
        (item) =>
          item.id ===
          job.projectId
      );

    res.json({
      success: true,

      job,

      project:
        project || null
    });
  }
);

/* =========================================================
   TRENDS
========================================================= */

app.get(
  "/api/trends",
  (req, res) => {
    res.json({
      success: true,

      trends: [
        {
          title:
            "Football & dépassement de soi",

          category:
            "Football",

          score: 94
        },

        {
          title:
            "Histoires émotionnelles",

          category:
            "Drama",

          score: 91
        },

        {
          title:
            "Animation cinématique",

          category:
            "Animation",

          score: 88
        },

        {
          title:
            "Action futuriste",

          category:
            "Action",

          score: 86
        }
      ]
    });
  }
);

/* =========================================================
   DASHBOARD
========================================================= */

app.get(
  "/api/dashboard",
  (req, res) => {
    const completed =
      projects.filter(
        (project) =>
          project.status ===
          "completed"
      ).length;

    const images =
      projects.reduce(
        (sum, project) =>
          sum +
          (
            project.images?.filter(
              (image) =>
                image.status ===
                "generated"
            ).length || 0
          ),
        0
      );

    const videos =
      projects.reduce(
        (sum, project) =>
          sum +
          (
            project.videos?.filter(
              (video) =>
                video.status !==
                "error"
            ).length || 0
          ),
        0
      );

    const totalProgress =
      projects.length
        ? Math.round(
            projects.reduce(
              (sum, project) =>
                sum +
                Number(
                  project.progress ||
                  0
                ),
              0
            ) /
              projects.length
          )
        : 0;

    res.json({
      success: true,

      stats: {
        projects:
          projects.length,

        completed,

        scenes:
          projects.reduce(
            (sum, project) =>
              sum +
              (
                project.scenes?.length ||
                0
              ),
            0
          ),

        images,

        videos,

        progress:
          totalProgress
      },

      projects:
        projects.slice(0, 8)
    });
  }
);

/* =========================================================
   MONTHLY REPORT
========================================================= */

app.get(
  "/api/report",
  (req, res) => {
    const now =
      new Date();

    const month =
      now.toLocaleString(
        "fr-FR",
        {
          month: "long",
          year: "numeric"
        }
      );

    const videos =
      projects.filter(
        (project) =>
          project.videos &&
          project.videos.length
      ).length;

    const scenes =
      projects.reduce(
        (sum, project) =>
          sum +
          (
            project.scenes?.length ||
            0
          ),
        0
      );

    const images =
      projects.reduce(
        (sum, project) =>
          sum +
          (
            project.images?.filter(
              (image) =>
                image.status ===
                "generated"
            ).length || 0
          ),
        0
      );

    const revenue =
      Object.values(
        platformStats
      ).reduce(
        (sum, platform) =>
          sum +
          Number(
            platform.revenue || 0
          ),
        0
      );

    const views =
      Object.values(
        platformStats
      ).reduce(
        (sum, platform) =>
          sum +
          Number(
            platform.views || 0
          ),
        0
      );

    const likes =
      Object.values(
        platformStats
      ).reduce(
        (sum, platform) =>
          sum +
          Number(
            platform.likes || 0
          ),
        0
      );

    const subscribers =
      Object.values(
        platformStats
      ).reduce(
        (sum, platform) =>
          sum +
          Number(
            platform.subscribers || 0
          ),
        0
      );

    res.json({
      success: true,

      report: {
        period:
          month,

        videos,

        scenes,

        images,

        views,

        likes,

        subscribers,

        revenue,

        currency:
          "USD",

        accountsConnected:
          Object.values(accounts)
            .filter(Boolean)
            .length,

        generatedAt:
          now.toISOString(),

        message:
          Object.values(accounts)
            .some(Boolean)
            ? "Rapport basé sur les données actuellement disponibles."
            : "Connecte tes plateformes pour obtenir les statistiques et revenus réels."
      }
    });
  }
);

/* =========================================================
   SERIES
========================================================= */

app.post(
  "/api/series",
  (req, res) => {
    const item = {
      id:
        makeId("series"),

      title:
        req.body.title ||
        "Nouvelle série",

      description:
        req.body.description ||
        "",

      episodes: [],

      createdAt:
        new Date().toISOString()
    };

    series.push(item);

    res.json({
      success: true,
      series: item
    });
  }
);

app.post(
  "/api/series/:id/episode",
  (req, res) => {
    const item =
      series.find(
        (serie) =>
          serie.id ===
          req.params.id
      );

    if (!item) {
      return res.status(404).json({
        error:
          "Série introuvable."
      });
    }

    const episode = {
      id:
        makeId("episode"),

      number:
        item.episodes.length + 1,

      title:
        req.body.title ||
        "Épisode " +
          (item.episodes.length + 1),

      createdAt:
        new Date().toISOString()
    };

    item.episodes.push(
      episode
    );

    res.json({
      success: true,
      episode
    });
  }
);

/* =========================================================
   PREMIUM UI
========================================================= */

function getHomePage() {
  return String.raw`<!DOCTYPE html>
<html lang="fr">
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>

<title>Cineflow — AI Video Studio</title>

<style>

*{
  box-sizing:border-box;
}

:root{
  --bg:#080D1A;
  --panel:#111D31;
  --panel2:#152640;
  --border:rgba(53,217,255,.18);
  --text:#F4FAFF;
  --muted:#91A5C4;
  --purple:#35D9FF;
  --pink:#668CFF;
  --blue:#35D9FF;
  --green:#43E6B0;
  --yellow:#FFD166;
  --red:#FF647C;
}

html{
  scroll-behavior:smooth;
}

body{
  margin:0;
  color:var(--text);
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background:
    radial-gradient(
      circle at 10% 0%,
      rgba(139,92,246,.23),
      transparent 28%
    ),
    radial-gradient(
      circle at 100% 0%,
      rgba(56,189,248,.12),
      transparent 25%
    ),
    var(--bg);

  min-height:100vh;
}

button,
textarea{
  font:inherit;
}

button{
  cursor:pointer;
}

.sidebar{
  position:fixed;
  left:0;
  top:0;
  bottom:0;
  width:245px;
  padding:22px 16px;
  border-right:1px solid var(--border);
  background:rgba(5,7,16,.88);
  backdrop-filter:blur(25px);
  z-index:20;
}

.logo{
  display:flex;
  gap:12px;
  align-items:center;
  padding:8px 10px 28px;
}

.logo-icon{
  width:43px;
  height:43px;
  display:grid;
  place-items:center;
  border-radius:14px;
  background:
    linear-gradient(
      135deg,
      var(--purple),
      var(--pink)
    );
  font-size:21px;
}

.logo strong{
  font-size:20px;
}

.logo small{
  display:block;
  color:var(--muted);
  font-size:9px;
  margin-top:3px;
  letter-spacing:1px;
}

.nav-title{
  color:#626a87;
  font-size:10px;
  letter-spacing:1.4px;
  text-transform:uppercase;
  padding:13px 12px 8px;
}

.nav{
  display:flex;
  flex-direction:column;
  gap:5px;
}

.nav button{
  width:100%;
  border:0;
  border-radius:12px;
  padding:12px;
  color:#aeb4ce;
  background:transparent;
  text-align:left;
}

.nav button:hover,
.nav button.active{
  color:white;
  background:rgba(139,92,246,.13);
}

.connection{
  position:absolute;
  left:16px;
  right:16px;
  bottom:20px;
  padding:13px;
  border:1px solid var(--border);
  border-radius:15px;
  background:rgba(255,255,255,.025);
  font-size:12px;
}

.dot{
  display:inline-block;
  width:8px;
  height:8px;
  margin-right:8px;
  border-radius:50%;
  background:var(--green);
  box-shadow:0 0 12px var(--green);
}

.main{
  margin-left:245px;
  padding:25px 30px 80px;
}

.topbar{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:22px;
}

.muted{
  color:var(--muted);
}

.icon{
  border:1px solid var(--border);
  background:rgba(255,255,255,.04);
  color:white;
  width:40px;
  height:40px;
  border-radius:12px;
}

.hero{
  position:relative;
  overflow:hidden;
  min-height:350px;
  padding:40px;
  border:1px solid var(--border);
  border-radius:27px;
  background:
    linear-gradient(
      120deg,
      rgba(139,92,246,.21),
      rgba(236,72,153,.06)
    );
}

.hero-content{
  position:relative;
  z-index:2;
  max-width:720px;
}

.eyebrow{
  color:#b9a8ff;
  font-size:11px;
  font-weight:800;
  letter-spacing:1.5px;
  margin-bottom:15px;
}

.hero h1{
  margin:0;
  font-size:clamp(38px,6vw,62px);
  line-height:.98;
  letter-spacing:-3px;
}

.hero h1 span{
  background:
    linear-gradient(
      90deg,
      white,
      #c4b5fd,
      #f9a8d4
    );
  -webkit-background-clip:text;
  color:transparent;
}

.hero p{
  color:#abb2cc;
  max-width:620px;
  line-height:1.7;
  margin:20px 0 26px;
}

.actions{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
}

.primary{
  border:0;
  color:white;
  padding:14px 19px;
  border-radius:13px;
  font-weight:800;
  background:
    linear-gradient(
      135deg,
      var(--purple),
      var(--pink)
    );
}

.secondary{
  border:1px solid var(--border);
  color:white;
  padding:14px 18px;
  border-radius:13px;
  background:rgba(255,255,255,.045);
}

.stats{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:14px;
  margin-top:17px;
}

.stat{
  padding:19px;
  border:1px solid var(--border);
  border-radius:18px;
  background:rgba(16,19,34,.78);
}

.stat small{
  color:var(--muted);
}

.stat strong{
  display:block;
  font-size:28px;
  margin-top:6px;
}

.section{
  margin-top:31px;
}

.section-head{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:14px;
}

.section-head h2{
  margin:0;
  font-size:21px;
}

.section-head span{
  color:var(--muted);
  font-size:11px;
}

.creator{
  display:grid;
  grid-template-columns:1.4fr .6fr;
  gap:15px;
}

.card{
  padding:20px;
  border:1px solid var(--border);
  border-radius:20px;
  background:rgba(16,19,34,.78);
}

.card-title{
  font-weight:800;
  margin-bottom:12px;
}

textarea{
  width:100%;
  min-height:145px;
  padding:16px;
  resize:vertical;
  outline:none;
  border:1px solid var(--border);
  border-radius:15px;
  color:white;
  background:rgba(0,0,0,.25);
}

.chips{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  margin:13px 0;
}

.chip{
  border:1px solid var(--border);
  color:#bfc5db;
  background:rgba(255,255,255,.035);
  padding:8px 12px;
  border-radius:999px;
  font-size:11px;
}

.chip.active{
  color:white;
  background:rgba(139,92,246,.17);
  border-color:rgba(139,92,246,.5);
}

.autopilot{
  background:
    linear-gradient(
      145deg,
      rgba(139,92,246,.2),
      rgba(236,72,153,.06)
    );
}

.auto-icon{
  width:48px;
  height:48px;
  display:grid;
  place-items:center;
  border-radius:15px;
  background:
    linear-gradient(
      135deg,
      var(--purple),
      var(--pink)
    );
  font-size:23px;
}

.autopilot h3{
  margin:15px 0 8px;
}

.autopilot p{
  color:var(--muted);
  font-size:13px;
  line-height:1.6;
}

.workflow{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:10px;
}

.step{
  padding:16px;
  min-height:125px;
  border:1px solid var(--border);
  border-radius:16px;
  background:rgba(255,255,255,.025);
}

.step-number{
  color:#aaa4ff;
  font-size:10px;
}

.step-icon{
  font-size:24px;
  margin:10px 0 7px;
}

.step strong{
  font-size:12px;
}

.step p{
  color:var(--muted);
  font-size:10px;
  line-height:1.5;
}

.projects{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:14px;
}

.project{
  overflow:hidden;
  border:1px solid var(--border);
  border-radius:18px;
  background:rgba(16,19,34,.78);
}

.cover{
  height:140px;
  display:flex;
  align-items:flex-end;
  padding:13px;
  background:
    radial-gradient(
      circle at 20% 20%,
      rgba(139,92,246,.5),
      transparent 35%
    ),
    radial-gradient(
      circle at 80% 80%,
      rgba(236,72,153,.35),
      transparent 35%
    ),
    #111426;
}

.cover span{
  font-size:9px;
  padding:5px 8px;
  border-radius:7px;
  background:rgba(0,0,0,.45);
}

.project-body{
  padding:15px;
}

.project-body h3{
  margin:0;
  font-size:14px;
}

.project-body p{
  color:var(--muted);
  font-size:10px;
}

.progress{
  height:5px;
  overflow:hidden;
  margin-top:12px;
  border-radius:20px;
  background:rgba(255,255,255,.07);
}

.progress i{
  display:block;
  height:100%;
  background:
    linear-gradient(
      90deg,
      var(--purple),
      var(--pink)
    );
}

.timeline{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:11px;
}

.scene{
  overflow:hidden;
  border:1px solid var(--border);
  border-radius:17px;
  background:rgba(16,19,34,.78);
}

.scene-visual{
  height:135px;
  display:grid;
  place-items:center;
  font-size:30px;
  background:
    radial-gradient(
      circle at 20% 20%,
      rgba(56,189,248,.16),
      transparent 35%
    ),
    radial-gradient(
      circle at 80% 80%,
      rgba(139,92,246,.22),
      transparent 40%
    ),
    #111426;
  overflow:hidden;
}

.scene-visual img{
  width:100%;
  height:100%;
  object-fit:cover;
}

.scene-body{
  padding:12px;
}

.scene-label{
  color:#aaa4ff;
  font-size:9px;
  text-transform:uppercase;
  font-weight:800;
}

.scene h3{
  margin:5px 0;
  font-size:13px;
}

.scene p{
  color:var(--muted);
  font-size:10px;
  line-height:1.5;
}

.image-actions{
  display:flex;
  gap:7px;
  margin-top:9px;
}

.small-btn{
  flex:1;
  border:1px solid var(--border);
  border-radius:9px;
  padding:7px;
  color:white;
  background:rgba(255,255,255,.04);
  font-size:9px;
}

.formats{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:14px;
}

.format{
  display:flex;
  align-items:center;
  gap:14px;
  padding:18px;
  border:1px solid var(--border);
  border-radius:18px;
  background:rgba(16,19,34,.78);
}

.preview{
  width:45px;
  height:60px;
  border:2px solid #a5abc0;
  border-radius:6px;
}

.preview.landscape{
  width:60px;
  height:38px;
}

.preview.square{
  width:48px;
  height:48px;
}

.format h3{
  margin:0;
  font-size:13px;
}

.format p{
  margin:5px 0 0;
  color:var(--muted);
  font-size:10px;
}

/* NEW DASHBOARD */

.dashboard-grid{
  display:grid;
  grid-template-columns:repeat(2,1fr);
  gap:15px;
}

.dashboard-card{
  padding:20px;
  border:1px solid var(--border);
  border-radius:20px;
  background:
    linear-gradient(
      145deg,
      rgba(16,19,34,.95),
      rgba(12,14,26,.9)
    );
}

.dashboard-card.full{
  grid-column:1/-1;
}

.dashboard-title{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:17px;
}

.dashboard-title h3{
  margin:0;
  font-size:15px;
}

.status-badge{
  padding:6px 9px;
  border-radius:999px;
  font-size:9px;
  background:rgba(34,197,94,.1);
  color:#86efac;
}

.status-badge.off{
  background:rgba(239,68,68,.1);
  color:#fca5a5;
}

.metric-grid{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:10px;
}

.metric{
  padding:13px;
  border:1px solid var(--border);
  border-radius:13px;
  background:rgba(255,255,255,.025);
}

.metric span{
  display:block;
  color:var(--muted);
  font-size:9px;
}

.metric strong{
  display:block;
  margin-top:5px;
  font-size:20px;
}

.platform-list{
  display:grid;
  gap:10px;
}

.platform{
  display:flex;
  justify-content:space-between;
  align-items:center;
  padding:13px;
  border:1px solid var(--border);
  border-radius:13px;
  background:rgba(255,255,255,.025);
}

.platform-left{
  display:flex;
  align-items:center;
  gap:10px;
}

.platform-icon{
  width:34px;
  height:34px;
  display:grid;
  place-items:center;
  border-radius:10px;
  background:rgba(255,255,255,.06);
}

.platform small{
  display:block;
  color:var(--muted);
  margin-top:2px;
  font-size:9px;
}

.platform button{
  border:1px solid var(--border);
  color:white;
  background:rgba(255,255,255,.04);
  border-radius:9px;
  padding:7px 10px;
  font-size:9px;
}

.host-grid{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:10px;
}

.host-item{
  padding:13px;
  border:1px solid var(--border);
  border-radius:13px;
  background:rgba(255,255,255,.025);
}

.host-item span{
  display:block;
  color:var(--muted);
  font-size:9px;
}

.host-item strong{
  display:block;
  margin-top:6px;
  font-size:13px;
}

.report-box{
  padding:18px;
  border-radius:15px;
  background:
    linear-gradient(
      135deg,
      rgba(139,92,246,.12),
      rgba(236,72,153,.07)
    );
}

.report-box h4{
  margin:0 0 8px;
}

.report-box p{
  margin:0;
  color:var(--muted);
  line-height:1.6;
  font-size:11px;
}

.mobile{
  display:none;
}

@media(max-width:1050px){

  .stats{
    grid-template-columns:repeat(2,1fr);
  }

  .creator{
    grid-template-columns:1fr;
  }

  .projects{
    grid-template-columns:repeat(2,1fr);
  }

  .workflow,
  .timeline{
    grid-template-columns:repeat(3,1fr);
  }

  .dashboard-grid{
    grid-template-columns:1fr;
  }

  .dashboard-card.full{
    grid-column:auto;
  }
}

@media(max-width:720px){

  .sidebar{
    display:none;
  }

  .main{
    margin-left:0;
    padding:16px 13px 90px;
  }

  .hero{
    padding:26px 20px;
    border-radius:22px;
  }

  .hero h1{
    font-size:39px;
  }

  .stats,
  .projects,
  .workflow,
  .timeline,
  .formats,
  .dashboard-grid{
    grid-template-columns:1fr;
  }

  .metric-grid{
    grid-template-columns:repeat(2,1fr);
  }

  .host-grid{
    grid-template-columns:1fr;
  }

  .mobile{
    display:flex;
    position:fixed;
    left:10px;
    right:10px;
    bottom:10px;
    height:64px;
    align-items:center;
    justify-content:space-around;
    z-index:100;
    border:1px solid var(--border);
    border-radius:19px;
    background:rgba(9,11,23,.92);
    backdrop-filter:blur(20px);
  }

  .mobile button{
    border:0;
    background:transparent;
    color:#858da8;
    font-size:19px;
  }
}

/* JARVIS — interface lumineuse adaptative */
.jarvis-panel {
  --jarvis-color: #35d9ff;
  position: relative;
  margin: 24px 0;
  padding: 24px;
  overflow: hidden;
  border: 1px solid rgba(53,217,255,.35);
  border-radius: 22px;
  background: radial-gradient(ellipse at 50% 15%,
    rgba(53,217,255,.12), transparent 60%), #080f20;
  box-shadow: 0 0 32px rgba(53,217,255,.08);
}
.jarvis-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.jarvis-label { color: var(--jarvis-color); font-size: 10px; letter-spacing: 3px; }
.jarvis-heading h2 { font-size: 30px; letter-spacing: 7px; margin: 5px 0; }
.jarvis-heading p, .jarvis-note { color: #91a5c4; font-size: 12px; }
.jarvis-status {
  color: var(--jarvis-color);
  border: 1px solid currentColor;
  border-radius: 20px;
  padding: 7px 10px;
  font-size: 10px;
}
.jarvis-core-wrap {
  width: 150px; height: 150px; margin: 28px auto 20px;
  position: relative; display: grid; place-items: center;
}
.jarvis-core {
  width: 82px; height: 82px; border-radius: 50%;
  border: 1px solid var(--jarvis-color);
  color: white; font-size: 32px; cursor: pointer;
  background: radial-gradient(circle, #173b62, #071020 72%);
  box-shadow: 0 0 20px var(--jarvis-color),
    inset 0 0 20px rgba(53,217,255,.3);
  animation: jarvisPulse 2.8s ease-in-out infinite;
}
.jarvis-ring {
  position: absolute; inset: 5px; border-radius: 50%;
  border: 1px solid var(--jarvis-color); opacity: .6;
}
.jarvis-ring-one { animation: jarvisSpin 9s linear infinite; }
.jarvis-ring-two {
  inset: 17px; border-style: dashed;
  animation: jarvisSpin 14s linear infinite reverse;
}
.jarvis-reply { text-align: center; margin: 14px 0; line-height: 1.6; }
.jarvis-form { display: flex; gap: 8px; margin-top: 18px; }
.jarvis-form input {
  flex: 1; min-width: 0; padding: 13px;
  color: white; background: #101b30;
  border: 1px solid #29405d; border-radius: 12px;
}
.jarvis-form button, .jarvis-voice-button {
  padding: 12px 15px; border-radius: 12px;
  color: white; background: #123752;
  border: 1px solid var(--jarvis-color);
}
.jarvis-voice-button { display: block; margin: 12px auto; }
.jarvis-note { text-align: center; margin-top: 14px; }
@keyframes jarvisPulse {
  50% { transform: scale(1.06); box-shadow: 0 0 36px var(--jarvis-color); }
}
@keyframes jarvisSpin { to { transform: rotate(360deg); } }
@media(max-width:520px) {
  .jarvis-panel { padding: 17px; }
  .jarvis-form { flex-direction: column; }
  .jarvis-form button { width: 100%; }
}
@media(prefers-reduced-motion:reduce) {
  .jarvis-core, .jarvis-ring { animation: none; }
}
/* CINEFLOW — thème futuriste unifié avec JARVIS */

body {
  background:
    radial-gradient(
      ellipse at 50% 0%,
      rgba(53,217,255,.10),
      transparent 42%
    ),
    radial-gradient(
      ellipse at 100% 100%,
      rgba(102,140,255,.07),
      transparent 38%
    ),
    var(--bg);
}

.sidebar {
  background: rgba(8,13,26,.94);
  border-right-color: rgba(53,217,255,.20);
}

.logo-icon,
.auto-icon {
  background: linear-gradient(135deg,#35D9FF,#668CFF);
  color: #071020;
  box-shadow: 0 0 22px rgba(53,217,255,.22);
}

.card,
.stat,
.project,
.dashboard-card,
.step {
  background: linear-gradient(
    145deg,
    rgba(17,29,49,.94),
    rgba(8,15,30,.94)
  );
  border-color: rgba(53,217,255,.17);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
  transition:
    border-color .2s ease,
    box-shadow .2s ease,
    transform .2s ease;
}

.card:hover,
.project:hover,
.dashboard-card:hover {
  border-color: rgba(53,217,255,.48);
  box-shadow: 0 0 22px rgba(53,217,255,.07);
}

button.primary,
.actions .primary {
  color: #06111D;
  background: linear-gradient(135deg,#35D9FF,#668CFF);
  border: 1px solid rgba(53,217,255,.65);
  box-shadow: 0 0 20px rgba(53,217,255,.15);
}

button.secondary,
.nav button,
.chip,
.icon {
  border-color: rgba(53,217,255,.20);
}

button.secondary:hover,
.nav button:hover,
.nav button.active,
.chip.active,
.icon:hover {
  color: #35D9FF;
  background: rgba(53,217,255,.09);
  border-color: rgba(53,217,255,.45);
}

input,
textarea,
select {
  accent-color: #35D9FF;
}

input:focus,
textarea:focus,
select:focus {
  outline: none;
  border-color: #35D9FF;
  box-shadow: 0 0 0 3px rgba(53,217,255,.10);
}

.workflow .step-number,
.section-head span {
  color: #35D9FF;
}

@media (prefers-reduced-motion: reduce) {
  .card,
  .project,
  .dashboard-card {
    transition: none;
  }
}

/* CINEFLOW — effets holographiques complémentaires */

/* 1. Halo lumineux autour des panneaux */
.card,
.stat,
.project,
.dashboard-card {
  position: relative;
  overflow: hidden;
  isolation: isolate;
  transition:
    transform 0.25s ease,
    border-color 0.25s ease,
    box-shadow 0.25s ease;
}

/* 2. Reflet holographique au survol */
.card::after,
.project::after,
.dashboard-card::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    115deg,
    transparent 20%,
    rgba(53, 217, 255, 0.08) 45%,
    transparent 70%
  );
  transform: translateX(-110%);
  transition: transform 0.65s ease;
}

.card:hover::after,
.project:hover::after,
.dashboard-card:hover::after {
  transform: translateX(110%);
}

.card:hover,
.project:hover,
.dashboard-card:hover {
  transform: translateY(-3px);
  border-color: rgba(53, 217, 255, 0.55);
  box-shadow:
    0 0 18px rgba(53, 217, 255, 0.12),
    inset 0 0 15px rgba(53, 217, 255, 0.025);
}

/* 3. Pulsation discrète des boutons principaux */
button.primary,
.actions .primary {
  animation: cineflowButtonGlow 3s ease-in-out infinite;
  transition: transform 0.2s ease;
}

button.primary:hover,
.actions .primary:hover {
  transform: translateY(-2px);
}

@keyframes cineflowButtonGlow {
  0%, 100% {
    box-shadow: 0 0 10px rgba(53, 217, 255, 0.12);
  }
  50% {
    box-shadow: 0 0 23px rgba(53, 217, 255, 0.28);
  }
}

/* 4. Mouvement doux lors du chargement des panneaux */
@keyframes cineflowPanelEnter {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.dashboard-card,
.stat {
  animation: cineflowPanelEnter 0.45s ease both;
}

/* 5. Respect des préférences de mouvement */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}

</style>

</head>

<body>

<aside class="sidebar">

  <div class="logo">

    <div class="logo-icon">
      ✦
    </div>

    <div>
      <strong>Cineflow</strong>
      <small>AI VIDEO STUDIO</small>
    </div>

  </div>

  <div class="nav-title">
    Workspace
  </div>

  <div class="nav">

    <button
      class="active"
      onclick="go('home')"
    >
      🏠 &nbsp; Accueil
    </button>

    <button onclick="go('creator')">
      ✦ &nbsp; Créer
    </button>

    <button onclick="go('scenes')">
      ▣ &nbsp; Studio
    </button>

    <button onclick="go('formats')">
      ◫ &nbsp; Formats
    </button>

    <button onclick="go('projects')">
      ▤ &nbsp; Projets
    </button>

    <button onclick="go('dashboard')">
      📊 &nbsp; Analytics
    </button>

    <button onclick="go('revenue')">
      💰 &nbsp; Revenus
    </button>

    <button onclick="checkHosting()">
      🖥️ &nbsp; Système
    </button>

  </div>

  <div class="connection">

    <span class="dot"></span>

    Cineflow

    <span
      id="sideStatus"
      style="float:right;color:#6ee7b7"
    >
      En ligne
    </span>

  </div>

</aside>

<main class="main">

  <div class="topbar">

    <span class="muted">
      Cineflow / Studio de création
    </span>

    <div>

      <button
        class="icon"
        onclick="testGemini()"
      >
        ✦
      </button>

      <button
        class="icon"
        onclick="loadEverything()"
      >
        ↻
      </button>

    </div>

  </div>

  <!-- HERO -->

  <section
    class="hero"
    id="home"
  >

    <div class="hero-content">

      <div class="eyebrow">
        ✦ TON ESPACE DE CRÉATION IA
      </div>

      <h1>
        Transforme une idée<br>
        en <span>film.</span>
      </h1>

      <p>
        Cineflow imagine ton histoire,
        construit les scènes, génère les
        visuels et prépare ton projet vidéo.
      </p>

      <div class="actions">

        <button
          class="primary"
          onclick="go('creator')"
        >
          ✦ Créer une vidéo
        </button>

        <button
          class="secondary"
          onclick="autopilot()"
        >
          ⚡ Auto-Pilote
        </button>

      </div>

    </div>

  </section>

<!-- JARVIS : panneau principal -->
<section class="jarvis-panel" id="jarvis">
  <div class="jarvis-heading">
    <div>
      <span class="jarvis-label">CINEFLOW INTELLIGENCE</span>
      <h2>JARVIS</h2>
      <p>Ton assistant de création</p>
    </div>
    <span id="jarvisStatus" class="jarvis-status">PRÊT</span>
  </div>

  <div class="jarvis-core-wrap">
    <div class="jarvis-ring jarvis-ring-one"></div>
    <div class="jarvis-ring jarvis-ring-two"></div>
    <button id="jarvisCore" class="jarvis-core"
      type="button" aria-label="Activer la voix de JARVIS"
      onclick="jarvisStartVoice()">✦</button>
  </div>

  <p id="jarvisReply" class="jarvis-reply">
    Bonjour ! Que veux-tu créer aujourd'hui ?
  </p>

  <form id="jarvisForm" class="jarvis-form"
    onsubmit="jarvisSend(event)">
    <input id="jarvisInput" type="text"
      placeholder="Écris une commande à JARVIS…"
      autocomplete="off" maxlength="500" required>
    <button type="submit">Envoyer ↗</button>
  </form>

  <button class="jarvis-voice-button" type="button"
    onclick="jarvisStartVoice()">🎙️ Parler à JARVIS</button>
  <p class="jarvis-note">
    Les commandes seront connectées aux fonctions Cineflow après validation.
  </p>
</section>

  <!-- QUICK STATS -->

  <div class="stats">

    <div class="stat">
      <small>Projets</small>
      <strong id="projectsStat">0</strong>
    </div>

    <div class="stat">
      <small>Scènes créées</small>
      <strong id="scenesStat">0</strong>
    </div>

    <div class="stat">
      <small>Images IA</small>
      <strong id="imagesStat">0</strong>
    </div>

    <div class="stat">
      <small>Vidéos</small>
      <strong id="videosStat">0</strong>
    </div>

  </div>

  <!-- CREATOR -->

  <section
    class="section"
    id="creator"
  >

    <div class="section-head">

      <h2>
        Créer quelque chose de nouveau
      </h2>

      <span>
        Étape 01 · Concept
      </span>

    </div>

    <div class="creator">

      <div class="card">

        <div class="card-title">
          Décris ton idée
        </div>

        <textarea
          id="prompt"
          placeholder="Exemple : un jeune footballeur africain rêve de devenir professionnel malgré les difficultés..."
        ></textarea>

<div style="display:flex;gap:10px;flex-wrap:wrap;margin:12px 0;">
  <button type="button" onclick="testDialogueVoice('fr')">
    🎙️ Tester les voix françaises
  </button>

  <button type="button" onclick="testDialogueVoice('en')">
    🎙️ Test English voices
  </button>
</div>

        <div class="chips">

          <button
            class="chip active"
            onclick="category(this,'Film')"
          >
            🎬 Film
          </button>

          <button
            class="chip"
            onclick="category(this,'Animation')"
          >
            ✨ Animation
          </button>

          <button
            class="chip"
            onclick="category(this,'Action')"
          >
            ⚡ Action
          </button>

          <button
            class="chip"
            onclick="category(this,'Drama')"
          >
            🎭 Drama
          </button>

          <button
            class="chip"
            onclick="category(this,'Football')"
          >
            ⚽ Football
          </button>

        </div>

        <button
          class="primary"
          style="width:100%"
          onclick="createProject()"
        >
          Générer mon projet →
        </button>

      </div>

      <div class="card autopilot">

        <div class="auto-icon">
          ⚡
        </div>

        <h3>
          Auto-Pilote
        </h3>

        <p>
          Donne simplement ton idée.
          Cineflow prépare automatiquement
          le scénario et les scènes.
        </p>

        <button
          class="primary"
          style="width:100%"
          onclick="autopilot()"
        >
          Lancer Auto-Pilote
        </button>

      </div>

    </div>

  </section>

  <!-- PIPELINE -->

  <section class="section">

    <div class="section-head">

      <h2>
        Le pipeline Cineflow
      </h2>

      <span>
        De l'idée au film
      </span>

    </div>

    <div class="workflow">

      <div class="step">
        <div class="step-number">01</div>
        <div class="step-icon">💡</div>
        <strong>Idée</strong>
        <p>Ton concept devient un projet.</p>
      </div>

      <div class="step">
        <div class="step-number">02</div>
        <div class="step-icon">📝</div>
        <strong>Scénario</strong>
        <p>Une histoire en 5 scènes.</p>
      </div>

      <div class="step">
        <div class="step-number">03</div>
        <div class="step-icon">🎨</div>
        <strong>Visuels</strong>
        <p>Images IA cinématographiques.</p>
      </div>

      <div class="step">
        <div class="step-number">04</div>
        <div class="step-icon">🎞️</div>
        <strong>Animation</strong>
        <p>Les scènes deviennent animées.</p>
      </div>

      <div class="step">
        <div class="step-number">05</div>
        <div class="step-icon">🎬</div>
        <strong>Film</strong>
        <p>Montage final.</p>
      </div>

    </div>

  </section>

  <!-- PROJECTS -->

  <section
    class="section"
    id="projects"
  >

    <div class="section-head">

      <h2>
        Mes projets
      </h2>

      <span id="projectCount">
        0 projet
      </span>

    </div>

    <div
      class="projects"
      id="projectsList"
    >

      <div class="project">

        <div class="cover">
          <span>NOUVEAU</span>
        </div>

        <div class="project-body">

          <h3>
            Ton prochain film
          </h3>

          <p>
            Commence avec une idée.
          </p>

          <div class="progress">
            <i style="width:0%"></i>
          </div>

        </div>

      </div>

    </div>

  </section>

  <!-- SCENES -->

  <section
    class="section"
    id="scenes"
  >

    <div class="section-head">

      <h2>
        Timeline des scènes
      </h2>

      <span>
        5 scènes cinématiques
      </span>

    </div>

    <div
      class="timeline"
      id="timeline"
    >

      <div class="scene">
        <div class="scene-visual">01</div>
        <div class="scene-body">
          <div class="scene-label">Scène 01</div>
          <h3>Ouverture</h3>
          <p>En attente du scénario.</p>
        </div>
      </div>

      <div class="scene">
        <div class="scene-visual">02</div>
        <div class="scene-body">
          <div class="scene-label">Scène 02</div>
          <h3>Développement</h3>
          <p>En attente du scénario.</p>
        </div>
      </div>

      <div class="scene">
        <div class="scene-visual">03</div>
        <div class="scene-body">
          <div class="scene-label">Scène 03</div>
          <h3>Conflit</h3>
          <p>En attente du scénario.</p>
        </div>
      </div>

      <div class="scene">
        <div class="scene-visual">04</div>
        <div class="scene-body">
          <div class="scene-label">Scène 04</div>
          <h3>Climax</h3>
          <p>En attente du scénario.</p>
        </div>
      </div>

      <div class="scene">
        <div class="scene-visual">05</div>
        <div class="scene-body">
          <div class="scene-label">Scène 05</div>
          <h3>Final</h3>
          <p>En attente du scénario.</p>
        </div>
      </div>

    </div>

    <div
      class="actions"
      style="margin-top:18px"
    >

      <button
        class="primary"
        onclick="generateImages(this)"
      >
        🎨 Générer les 5 images
      </button>

      <button
        class="secondary"
        onclick="animateProject()"
      >
        🎞️ Animer les scènes
      </button>
      <button
        class="secondary"
        id="magicHourTestButton"
        onclick="testMagicHourSceneOne(this)"
      >
        🎬 Tester Magic Hour — scène 1
      </button>
            <button
        class="secondary"
        id="generateVoicesButton"
        onclick="generateProjectVoices(this)"
      >
        🎙️ Générer les voix des 5 scènes
      </button>
    </div>
    <div id="magicHourTestResult" style="display:none;margin-top:14px;padding:12px;border-radius:10px;background:#20232b;color:white"></div>
  </section>

  <!-- FORMATS -->

  <section
    class="section"
    id="formats"
  >

    <div class="section-head">

      <h2>
        Formats intelligents
      </h2>

      <span>
        Un projet · plusieurs plateformes
      </span>

    </div>

    <div class="formats">

      <div class="format">

        <div
          class="preview landscape"
        ></div>

        <div>
          <h3>YouTube / Cinéma</h3>
          <p>16:9 · 1920 × 1080</p>
        </div>

      </div>

      <div class="format">

        <div class="preview"></div>

        <div>
          <h3>TikTok / Shorts / Reels</h3>
          <p>9:16 · 1080 × 1920</p>
        </div>

      </div>

      <div class="format">

        <div
          class="preview square"
        ></div>

        <div>
          <h3>Instagram</h3>
          <p>1:1 · 1080 × 1080</p>
        </div>

      </div>

    </div>

  </section>

  <!-- ANALYTICS -->

  <section
    class="section"
    id="dashboard"
  >

    <div class="section-head">

      <h2>
        📊 Centre de contrôle
      </h2>

      <span>
        Statistiques Cineflow
      </span>

    </div>

    <div class="dashboard-grid">

      <div class="dashboard-card full">

        <div class="dashboard-title">

          <h3>
            Performance de Cineflow
          </h3>

          <span
            class="status-badge"
            id="progressBadge"
          >
            0%
          </span>

        </div>

        <div class="metric-grid">

          <div class="metric">
            <span>Projets</span>
            <strong id="dashProjects">0</strong>
          </div>

          <div class="metric">
            <span>Scènes</span>
            <strong id="dashScenes">0</strong>
          </div>

          <div class="metric">
            <span>Images IA</span>
            <strong id="dashImages">0</strong>
          </div>

          <div class="metric">
            <span>Vidéos</span>
            <strong id="dashVideos">0</strong>
          </div>

        </div>

      </div>

      <!-- HOSTING -->

      <div class="dashboard-card">

        <div class="dashboard-title">

          <h3>
            🖥️ Vérification hébergement
          </h3>

          <span
            class="status-badge"
            id="hostingBadge"
          >
            Vérification...
          </span>

        </div>

        <div class="host-grid">

          <div class="host-item">
            <span>Hébergement</span>
            <strong id="hostProvider">
              —
            </strong>
          </div>

          <div class="host-item">
            <span>Serveur</span>
            <strong id="hostServer">
              —
            </strong>
          </div>

          <div class="host-item">
            <span>Gemini</span>
            <strong id="hostGemini">
              —
            </strong>
          </div>

          <div class="host-item">
            <span>Temps réponse</span>
            <strong id="hostResponse">
              —
            </strong>
          </div>

          <div class="host-item">
            <span>Node.js</span>
            <strong id="hostNode">
              —
            </strong>
          </div>

          <div class="host-item">
            <span>Uptime</span>
            <strong id="hostUptime">
              —
            </strong>
          </div>

        </div>

        <button
          class="secondary"
          style="width:100%;margin-top:13px"
          onclick="checkHosting()"
        >
          🔍 Vérifier maintenant
        </button>

      </div>

      <!-- AUTOPILOT -->

      <div class="dashboard-card">

        <div class="dashboard-title">

          <h3>
            🤖 Auto-Pilote
          </h3>

          <span
            class="status-badge"
          >
            ACTIF
          </span>

        </div>

        <div class="report-box">

          <h4>
            Automatisation Cineflow
          </h4>

          <p>
            Idée → scénario → scènes →
            images → animation → montage.
            Le moteur est prêt à être étendu
            vers l'automatisation complète.
          </p>

        </div>

      </div>

      <!-- MONTHLY REPORT -->

      <div class="dashboard-card full">

        <div class="dashboard-title">

          <h3>
            📈 Rapport mensuel
          </h3>

          <span
            id="reportPeriod"
            class="status-badge"
          >
            —
          </span>

        </div>

        <div class="metric-grid">

          <div class="metric">
            <span>Vidéos</span>
            <strong id="reportVideos">0</strong>
          </div>

          <div class="metric">
            <span>Vues</span>
            <strong id="reportViews">0</strong>
          </div>

          <div class="metric">
            <span>Likes</span>
            <strong id="reportLikes">0</strong>
          </div>

          <div class="metric">
            <span>Abonnés</span>
            <strong id="reportSubscribers">0</strong>
          </div>

        </div>

        <div
          class="report-box"
          style="margin-top:12px"
        >

          <h4>
            Résumé
          </h4>

          <p id="reportMessage">
            Chargement du rapport...
          </p>

        </div>

      </div>

    </div>

  </section>

  <!-- REVENUE -->

  <section
    class="section"
    id="revenue"
  >

    <div class="section-head">

      <h2>
        💰 Revenus & plateformes
      </h2>

      <span>
        Centre financier
      </span>

    </div>

    <div class="dashboard-grid">

      <div class="dashboard-card full">

        <div class="dashboard-title">

          <h3>
            💰 Résumé des revenus
          </h3>

          <span
            class="status-badge"
            id="revenueStatus"
          >
            Non connecté
          </span>

        </div>

        <div class="metric-grid">

          <div class="metric">
            <span>Vues</span>
            <strong id="revenueViews">
              0
            </strong>
          </div>

          <div class="metric">
            <span>Likes</span>
            <strong id="revenueLikes">
              0
            </strong>
          </div>

          <div class="metric">
            <span>Abonnés</span>
            <strong id="revenueSubscribers">
              0
            </strong>
          </div>

          <div class="metric">
            <span>Revenus estimés</span>
            <strong id="revenueTotal">
              $0
            </strong>
          </div>

        </div>

      </div>

      <div class="dashboard-card full">

        <div class="dashboard-title">

          <h3>
            🔗 Mes comptes
          </h3>

          <span>
            Connexions
          </span>

        </div>

        <div
          class="platform-list"
          id="platformList"
        >

          <div class="platform">
            Chargement...
          </div>

        </div>

      </div>

    </div>

  </section>

  <div
    style="
      text-align:center;
      margin-top:55px;
      color:#5f6680;
      font-size:10px;
    "
  >
    Cineflow · Ton espace de création assistée par intelligence artificielle
  </div>

</main>

<div class="mobile">

  <button onclick="go('home')">
    ⌂
  </button>

  <button onclick="go('creator')">
    ✦
  </button>

  <button onclick="go('scenes')">
    ▣
  </button>

  <button onclick="go('dashboard')">
    📊
  </button>

  <button onclick="go('revenue')">
    💰
  </button>

</div>

<script>

var currentCategory = "Film";
var currentProject = null;

/* =========================================================
   NAVIGATION
========================================================= */

function go(id){

  var element =
    document.getElementById(id);

  if(element){

    element.scrollIntoView({
      behavior:"smooth"
    });

  }

}

/* =========================================================
   CATEGORY
========================================================= */

function category(button,value){

  currentCategory = value;

  document
    .querySelectorAll(".chip")
    .forEach(function(item){

      item.classList.remove(
        "active"
      );

    });

  button.classList.add("active");

}

/* =========================================================
   ESCAPE
========================================================= */

function escapeHtml(value){

  return String(value || "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");

}

/* =========================================================
   CREATE PROJECT
========================================================= */

async function createProject(){

  var prompt =
    document
      .getElementById("prompt")
      .value
      .trim();

  if(!prompt){

    alert(
      "Écris ton idée de vidéo."
    );

    return;
  }

  try{

    var response =
      await fetch(
        "/api/project",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              prompt:prompt,
              category:
                currentCategory
            })
        }
      );

    var data =
      await response.json();

    if(!response.ok){

      throw new Error(
        data.error ||
        "Erreur Cineflow."
      );

    }

    currentProject =
      data.project;

    renderProject(
      data.project
    );

    loadEverything();

    alert(
      "✨ Projet Cineflow créé !"
    );

  }catch(error){

    alert(
      error.message
    );

  }

}

async function testDialogueVoice(language) {
  if (
    !currentProject ||
    !Array.isArray(currentProject.scenes) ||
    !currentProject.scenes.length
  ) {
    alert("Crée d'abord un projet avec ses scènes.");
    return;
  }

  const scene = currentProject.scenes[0];

  if (!Array.isArray(scene.dialogues) || !scene.dialogues.length) {
    alert("La scène 1 ne contient aucun dialogue.");
    return;
  }

  try {
    const response = await fetch("/api/tts/test-scene", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language,
        dialogues: scene.dialogues
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Erreur de génération audio.");
    }

  const audio = new Audio(
  "data:" + data.mimeType + ";base64," + data.audioBase64
);

    await audio.play();
  } catch (error) {
    alert("Test vocal impossible : " + error.message);
    console.error(error);
  }
}

async function generateProjectVoices(button) {
  if (!currentProject || !currentProject.id) {
    alert("Crée d'abord un nouveau projet Cineflow.");
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = "⏳ Génération des voix...";
  }

  try {
    const response = await fetch("/api/tts/generate-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: currentProject.id
      })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Échec de la génération des voix.");
    }

    alert(
      "🎙️ " + data.message +
      "\nPistes générées : " + data.tracks.length + "/5."
    );
  } catch (error) {
    alert("Génération audio impossible : " + error.message);
    console.error("Cineflow audio :", error);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "🎙️ Générer les voix des 5 scènes";
    }
  }
}

/* =========================================================
   AUTOPILOT
========================================================= */

async function autopilot(){

  var prompt =
    document
      .getElementById("prompt")
      .value
      .trim();

  if(!prompt){

    alert(
      "Décris ton idée avant de lancer Auto-Pilote."
    );

    go("creator");

    return;
  }

  try{

    var response =
      await fetch(
        "/api/autopilot",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              prompt:prompt,
              category:
                currentCategory
            })
        }
      );

    var data =
      await response.json();

    if(!response.ok){

      throw new Error(
        data.error ||
        "Auto-Pilote indisponible."
      );

    }

    currentProject =
      data.project;

    renderProject(
      data.project
    );

    loadEverything();

    alert(
      "⚡ Auto-Pilote Cineflow est lancé."
    );

  }catch(error){

    alert(
      error.message
    );

  }

}

/* =========================================================
   RENDER PROJECT
========================================================= */

function renderProject(project){

  if(!project) return;

  currentProject =
    project;

  var timeline =
    document.getElementById(
      "timeline"
    );

  if(!timeline) return;

  var scenes =
    project.scenes || [];

  if(!scenes.length) return;

  var html = "";

  scenes
    .slice(0,5)
    .forEach(
      function(scene,index){

        var number =
          String(index + 1)
            .padStart(2,"0");

        var title =
          escapeHtml(
            scene.title ||
            "Scène"
          );

        var description =
          escapeHtml(
            scene.description ||
            "Scène générée par Cineflow."
          );

        html +=
          '<div class="scene">' +

            '<div class="scene-visual">' +
              number +
            '</div>' +

            '<div class="scene-body">' +

              '<div class="scene-label">' +
                "Scène " +
                number +
              '</div>' +

              '<h3>' +
                title +
              '</h3>' +

              '<p>' +
                description +
              '</p>' +

            '</div>' +

          '</div>';

      }
    );

  timeline.innerHTML =
    html;

  loadProjects();

}

/* =========================================================
   TEST MAGIC HOUR : SCENE 1 UNIQUEMENT
========================================================= */

async function testMagicHourSceneOne(button) {
  var resultBox = document.getElementById("magicHourTestResult");

  if (!currentProject || !currentProject.id) {
    alert("Ouvre d'abord Avant Minuit dans Mes projets.");
    return;
  }

  var sceneOne = (currentProject.scenes || []).find(function(scene) {
    return Number(scene.number) === 1;
  });

  if (!sceneOne) {
    alert("La scène 1 est introuvable dans ce projet.");
    return;
  }

  var oldLabel = button.textContent;
  button.disabled = true;
  button.textContent = "⏳ Test en cours...";

  resultBox.style.display = "block";
  resultBox.textContent =
    "Envoi de la scène 1 à Magic Hour. Patiente pendant le traitement...";

  try {
    var response = await fetch("/api/magic-hour/test-scene", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        projectId: currentProject.id,
        sceneNumber: 1
      })
    });

    var data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error || "Le test Magic Hour a échoué."
      );
    }

    resultBox.textContent = "";

    var message = document.createElement("p");
    message.textContent =
      "✅ La vidéo de test de la scène 1 est prête !";
    resultBox.appendChild(message);

    var link = document.createElement("a");
    link.href = data.previewUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "▶ Ouvrir la vidéo";
    link.style.color = "#8ab4ff";
    link.style.display = "inline-block";
    link.style.marginTop = "10px";
    resultBox.appendChild(link);

  } catch (error) {
    resultBox.textContent =
      "❌ Erreur Magic Hour : " + error.message;
  } finally {
    button.disabled = false;
    button.textContent = oldLabel;
  }
}

/* =========================================================
   GENERATE IMAGES
========================================================= */

async function generateImages(button){

  if(!currentProject){

    alert(
      "Crée d'abord un projet."
    );

    go("creator");

    return;
  }

  if(
    !currentProject.scenes ||
    !currentProject.scenes.length
  ){

    alert(
      "Le projet ne contient pas encore de scènes."
    );

    return;
  }

  try{

    if(button){

      button.disabled =
        true;

      button.textContent =
        "🎨 Génération en cours...";

    }

    var response =
      await fetch(
        "/api/images",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              projectId:
                currentProject.id
            })
        }
      );

    var data =
      await response.json();

    if(!response.ok){

      throw new Error(
        data.error ||
        "Erreur génération images."
      );

    }

    currentProject =
      data.project ||
      currentProject;

    renderImages(
      currentProject
    );

    loadEverything();

    var generated =
      (data.images || [])
        .filter(
          function(item){

            return item.status ===
              "generated";

          }
        ).length;

    var errors =
      (data.images || [])
        .filter(
          function(item){

            return item.status ===
              "error";

          }
        );

    if(generated > 0){

      alert(
        "🎨 " +
        generated +
        " image(s) générée(s)." +
        (
          errors.length
            ? "\nCertaines images ont échoué."
            : ""
        )
      );

    }else{

      alert(
        "❌ Aucune image n'a été générée.\n\n" +
        (
          errors[0]?.error ||
          "Vérifie le quota Gemini."
        )
      );

    }

  }catch(error){

    alert(
      "Images : " +
      error.message
    );

  }finally{

    if(button){

      button.disabled =
        false;

      button.textContent =
        "🎨 Générer les 5 images";

    }

  }

}

/* =========================================================
   RENDER IMAGES
========================================================= */

function renderImages(project){

  var timeline =
    document.getElementById(
      "timeline"
    );

  if(!timeline) return;

  var scenes =
    project.scenes || [];

  var images =
    project.images || [];

  var html = "";

  scenes
    .slice(0,5)
    .forEach(
      function(scene,index){

        var number =
          String(index + 1)
            .padStart(2,"0");

        var image =
          images.find(
            function(item){

              return Number(
                item.scene
              ) ===
              Number(
                scene.number
              );

            }
          );

        var title =
          escapeHtml(
            scene.title ||
            "Scène"
          );

        var description =
          escapeHtml(
            scene.description ||
            ""
          );

        var visual =
          image &&
          image.status ===
            "generated"

            ? '<img src="' +
              (
                image.url ||
                "/api/image/" +
                image.id
              ) +
              '" alt="Scène ' +
              number +
              '">'

            : number;

        var actions =
          image &&
          image.status ===
            "generated"

            ? '<div class="image-actions">' +

                '<button class="small-btn" onclick="regenerateScene(' +
                  Number(scene.number) +
                ')">' +
                  "↻ Régénérer" +
                "</button>" +

              "</div>"

            : "";

        html +=
          '<div class="scene">' +

            '<div class="scene-visual">' +
              visual +
            '</div>' +

            '<div class="scene-body">' +

              '<div class="scene-label">' +
                "Scène " +
                number +
              '</div>' +

              '<h3>' +
                title +
              '</h3>' +

              '<p>' +
                description +
              '</p>' +

              actions +

            '</div>' +

          '</div>';

      }
    );

  timeline.innerHTML =
    html;

}

function renderFinalVideo(project){

  var timeline =
    document.getElementById("timeline");

  if(!timeline || !project) return;

  var videoUrl =
    project.finalVideo &&
    project.finalVideo.path
      ? "/api/final-video/" +
        encodeURIComponent(project.id)
      : "";

  if(!videoUrl) return;

  var existing =
    document.getElementById("cineflow-final-video");

  if(existing) existing.remove();

  var section =
    document.createElement("div");

  section.id = "cineflow-final-video";
  section.className = "scene";

  section.innerHTML =
    '<div class="scene-body">' +
      '<h3>🎬 Vidéo finale</h3>' +
      '<video controls playsinline ' +
        'style="width:100%;max-width:720px">' +
        '<source src="' + videoUrl +
        '" type="video/mp4">' +
        'Ton navigateur ne prend pas en charge la vidéo.' +
      '</video>' +
      '<p><a href="' + videoUrl +
        '" download="cineflow-video.mp4">' +
        '⬇️ Télécharger la vidéo' +
      '</a></p>' +
    '</div>';

  timeline.appendChild(section);

}

/* =========================================================
   REGENERATE SCENE
========================================================= */

async function regenerateScene(
  sceneNumber
){

  if(!currentProject){

    alert(
      "Aucun projet actif."
    );

    return;
  }

  try{

    var response =
      await fetch(
        "/api/regenerate-scene",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              projectId:
                currentProject.id,

              sceneNumber:
                sceneNumber

            })
        }
      );

    var data =
      await response.json();

    if(!response.ok){

      throw new Error(
        data.error ||
        "Impossible de régénérer la scène."
      );

    }

    var index =
      currentProject.images
        .findIndex(
          function(item){

            return Number(
              item.scene
            ) ===
            Number(
              sceneNumber
            );

          }
        );

    var replacement = {

      id:
        data.image.id,

      scene:
        sceneNumber,

      status:
        "generated",

      url:
        data.image.url

    };

    if(index >= 0){

      currentProject.images[
        index
      ] = replacement;

    }else{

      currentProject.images.push(
        replacement
      );

    }

    renderImages(
      currentProject
    );

    loadEverything();

    alert(
      "↻ Scène " +
      sceneNumber +
      " régénérée."
    );

  }catch(error){

    alert(
      "Régénération : " +
      error.message
    );

  }

}

/* =========================================================
   ANIMATION
========================================================= */

async function animateProject(){

  if(!currentProject){

    alert(
      "Crée d'abord un projet."
    );

    return;
  }

  try{

    var response =
      await fetch(
        "/api/animate",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              projectId:
                currentProject.id
            })
        }
      );

    var data =
      await response.json();

    if(!response.ok){

      throw new Error(
        data.error ||
        "Animation indisponible."
      );

    }

    currentProject.videos =
      data.videos || [];

    alert(
      "🎞️ Les 5 animations sont lancées.\n\nCineflow va maintenant suivre automatiquement leur progression."
    );

    loadEverything();

    var videosReady =
      false;

    while(!videosReady){

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            10000
          )
      );

      var projectResponse =
        await fetch(
          "/api/project/" +
          currentProject.id
        );

      var projectData =
        await projectResponse.json();

      if(!projectResponse.ok){

        throw new Error(
          projectData.error ||
          "Impossible de suivre le projet."
        );

      }

      currentProject =
        projectData.project;

      var projectVideos =
        currentProject.videos ||
        [];
        
         var videosSettled =
        projectVideos.length === 5 &&
        projectVideos.every(
          (video) =>
            video.status === "ready" ||
            video.status === "error"
        );

      if (!videosSettled) {
        continue;
      }

      var errors =
        projectVideos.filter(
          (video) =>
            video.status === "error"
        );

   
  
      if (errors.length > 0) {
        var failedScenes = errors
          .map((video) => video.scene)
          .join(", ");

        alert(
          "Certaines animations ont échoué (scènes : " +
          failedScenes +
          "). Cineflow va tenter un montage de secours avec les images."
        );

        try {
          var fallbackResponse = await fetch(
            "/api/final-video",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                projectId: currentProject.id,
                mode: "images"
              })
            }
          );

          var fallbackData =
            await fallbackResponse.json();

          if (
            !fallbackResponse.ok ||
            !fallbackData.jobId
          ) {
            throw new Error(
              fallbackData.error ||
              "Impossible de démarrer le montage de secours."
            );
          }

          var fallbackReady = false;

          while (!fallbackReady) {
            await new Promise((resolve) =>
              setTimeout(resolve, 3000)
            );

            var jobsResponse = await fetch(
              "/api/jobs"
            );

            var jobsData =
              await jobsResponse.json();

            if (!jobsResponse.ok) {
              throw new Error(
                "Impossible de suivre le montage de secours."
              );
            }

            var fallbackJob =
              (jobsData.jobs || []).find(
                (job) =>
                  job.id === fallbackData.jobId
              );

            if (!fallbackJob) {
              throw new Error(
                "Tâche de montage introuvable."
              );
            }

            if (fallbackJob.status === "error") {
              throw new Error(
                fallbackJob.error ||
                "Le montage de secours a échoué."
              );
            }

            fallbackReady =
              fallbackJob.status === "ready";
          }

        
          
          await loadEverything();

          var videoProjectResponse = await fetch(
            "/api/project/" +
            encodeURIComponent(currentProject.id)
          );

          if (!videoProjectResponse.ok) {
            throw new Error(
              "Impossible de récupérer le projet après le montage."
            );
          }

          var videoProjectData =
            await videoProjectResponse.json();

          if (!videoProjectData.project) {
            throw new Error(
              "Projet introuvable après le montage."
            );
          }

          currentProject =
            videoProjectData.project;

          renderFinalVideo(currentProject);


          alert(
            "🎉 Montage de secours terminé !\n\nCineflow a créé une vidéo à partir des images disponibles. Ce montage est un diaporama animé, pas les animations Veo manquantes."
          );
        } catch (fallbackError) {
          alert(
            "Le montage de secours a échoué : " +
            fallbackError.message
          );
        }

        return;
      }



      videosReady =
        projectVideos.length === 5 &&
        projectVideos.every(
          (video) =>
            video.status === "ready"
        ); 

      
console.log(
  "🎬 Progression vidéo :"
);

}

alert(
  "✅ Les 5 scènes sont prêtes !\n\nCineflow lance maintenant le montage final."
);


    var finalResponse =
      await fetch(
        "/api/final-video",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              projectId:
                currentProject.id
            })
        }
      );

    var finalData =
      await finalResponse.json();

    if(!finalResponse.ok){

      throw new Error(
        finalData.error ||
        "Montage final impossible."
      );

    }

    var jobId =
      finalData.jobId;

    var finalReady =
      false;

    while(!finalReady){

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            5000
          )
      );

      var jobsResponse =
        await fetch(
          "/api/jobs"
        );

      var jobsData =
        await jobsResponse.json();

      var job =
        (jobsData.jobs || [])
          .find(
            (item) =>
              item.id ===
              jobId
          );

      if(!job){

        continue;

      }

      console.log(
        "🎞️ Montage final :",
        job.status,
        job.progress
      );

      if(
        job.status ===
        "error"
      ){

        throw new Error(
          job.error ||
          "Le montage final a échoué."
        );

      }

      finalReady =
        job.status ===
        "ready";

      if(finalReady){

        currentProject.finalVideo = {
          path:
            job.filePath,

          jobId:
            jobId
        };

      }

    }

    loadEverything();
    
    renderFinalVideo(currentProject);
    
    alert(
      "🎉 Film final terminé !\n\nTon film de 5 scènes est maintenant prêt."
    );

  }catch(error){

    alert(
      "Animation : " +
      error.message
    );

  }

}

/* =========================================================
   PROJECT LIST
========================================================= */
async function selectProject(projectId) {
  try {
    var response = await fetch(
      "/api/project/" + encodeURIComponent(projectId)
    );

    var data = await response.json();

    if (!response.ok || !data.project) {
      throw new Error(
        data.error || "Impossible d'ouvrir le projet."
      );
    }

    currentProject = data.project;

    if (
      currentProject.images &&
      currentProject.images.length > 0
    ) {
      renderImages(currentProject);
    } else {
      renderProject(currentProject);
    }

    var timeline = document.getElementById("timeline");

    if (timeline) {
      timeline.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }

  } catch (error) {
    console.error("Erreur ouverture projet :", error);
    alert("Impossible d'ouvrir le projet : " + error.message);
  }
}

async function loadProjects() {
  try {
    const response = await fetch("/api/projects");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Erreur de chargement.");
    }

    const list = data.projects || [];
    const container = document.getElementById("projectsList");
    const count = document.getElementById("projectCount");

    if (!container || !count) return;

    count.textContent =
      list.length + " projet" + (list.length > 1 ? "s" : "");

    if (!list.length) {
      container.innerHTML = "<p>Aucun projet enregistré.</p>";
      return;
    }

      var html = "";

    list.slice(0, 6).forEach(function(project) {
      var id = escapeHtml(String(project.id || ""));
      var title = escapeHtml(project.title || "Projet Cineflow");
      var category = escapeHtml(
        (project.category || "FILM").toUpperCase()
      );
      var status = escapeHtml(project.status || "Projet");
      var progress = Math.max(
        0,
        Math.min(100, Number(project.progress || 0))
      );

      html +=
        '<div class="project">' +
          '<div class="cover"><span>' + category + '</span></div>' +
          '<div class="project-body">' +
            '<h3>' + title + '</h3>' +
            '<p>' + status + '</p>' +
            '<div class="progress"><i style="width:' +
              progress + '%"></i></div>' +
            '<button type="button" class="small-btn" ' +
              'data-project-id="' + id + '" ' +
              'onclick="event.stopPropagation();deleteProject(this.dataset.projectId)">' +
              '🗑️ Supprimer</button>' +
            '<button type="button" class="small-btn" ' +
              'data-project-id="' + id + '" ' +
              'onclick="event.stopPropagation();selectProject(this.dataset.projectId)">' +
              '📂 Ouvrir</button>' +
          '</div>' +
        '</div>';
    });
    
      container.innerHTML = html;
  } catch (error) {
    console.error("Erreur chargement projets :", error);
  }
}

async function deleteProject(projectId) {
  if (!projectId) return;

  if (!confirm(
    "Veux-tu vraiment supprimer ce projet ? Cette action est définitive."
  )) {
    return;
  }

  try {
    const response = await fetch(
      "/api/project/" + encodeURIComponent(projectId),
      { method: "DELETE" }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Suppression impossible.");
    }

    if (currentProject && currentProject.id === projectId) {
      currentProject = null;
    }

    await loadProjects();

    alert("✅ Projet supprimé.");
  } catch (error) {
    alert("❌ Erreur : " + error.message);
  }
}

/* =========================================================
   DASHBOARD
========================================================= */

async function loadDashboard(){

  try{

    var response =
      await fetch(
        "/api/dashboard"
      );

    var data =
      await response.json();

    if(!data.stats){
      return;
    }

    var stats =
      data.stats;

    var ids = {

      projectsStat:
        stats.projects,

      scenesStat:
        stats.scenes,

      imagesStat:
        stats.images,

      videosStat:
        stats.videos,

      dashProjects:
        stats.projects,

      dashScenes:
        stats.scenes,

      dashImages:
        stats.images,

      dashVideos:
        stats.videos

    };

    Object.keys(ids)
      .forEach(function(id){

        var element =
          document.getElementById(
            id
          );

        if(element){

          element.textContent =
            ids[id] || 0;

        }

      });

    var badge =
      document.getElementById(
        "progressBadge"
      );

    if(badge){

      badge.textContent =
        (
          stats.progress || 0
        ) +
        "%";

    }

    loadProjects();

  }catch(error){

    console.log(error);

  }

}

/* =========================================================
   HOSTING
========================================================= */

async function checkHosting(){

  try{

    var response =
      await fetch(
        "/api/hosting"
      );

    var data =
      await response.json();

    if(!response.ok){

      throw new Error(
        "Impossible de vérifier le serveur."
      );

    }

    var hosting =
      data.hosting;

    var gemini =
      data.gemini;

    document.getElementById(
      "hostProvider"
    ).textContent =
      hosting.provider;

    document.getElementById(
      "hostServer"
    ).textContent =
      hosting.status ===
      "online"
        ? "🟢 En ligne"
        : "🔴 Hors ligne";

    document.getElementById(
      "hostGemini"
    ).textContent =
      gemini.configured
        ? "🟢 Configuré"
        : "🔴 Manquant";

    document.getElementById(
      "hostResponse"
    ).textContent =
      hosting.responseTime +
      " ms";

    document.getElementById(
      "hostNode"
    ).textContent =
      hosting.node;

    document.getElementById(
      "hostUptime"
    ).textContent =
      hosting.uptime +
      " s";

    var badge =
      document.getElementById(
        "hostingBadge"
      );

    if(badge){

      badge.textContent =
        hosting.status ===
        "online"
          ? "EN LIGNE"
          : "ERREUR";

      badge.classList.toggle(
        "off",
        hosting.status !==
        "online"
      );

    }

    var side =
      document.getElementById(
        "sideStatus"
      );

    if(side){

      side.textContent =
        hosting.status ===
        "online"
          ? "En ligne"
          : "Erreur";

    }

  }catch(error){

    console.log(error);

  }

}

/* =========================================================
   MONTHLY REPORT
========================================================= */

async function loadReport(){

  try{

    var response =
      await fetch(
        "/api/report"
      );

    var data =
      await response.json();

    var report =
      data.report;

    if(!report) return;

    document.getElementById(
      "reportPeriod"
    ).textContent =
      report.period;

    document.getElementById(
      "reportVideos"
    ).textContent =
      report.videos || 0;

    document.getElementById(
      "reportViews"
    ).textContent =
      report.views || 0;

    document.getElementById(
      "reportLikes"
    ).textContent =
      report.likes || 0;

    document.getElementById(
      "reportSubscribers"
    ).textContent =
      report.subscribers || 0;

    document.getElementById(
      "reportMessage"
    ).textContent =
      report.message;

  }catch(error){

    console.log(error);

  }

}

/* =========================================================
   ACCOUNTS
========================================================= */

async function loadAccounts(){

  try{

    var response =
      await fetch(
        "/api/accounts"
      );

    var data =
      await response.json();

    var accountData =
      data.accounts || {};

    var list =
      document.getElementById(
        "platformList"
      );

    if(!list) return;

    var platforms = [

      {
        key:"youtube",
        name:"YouTube",
        icon:"▶️"
      },

      {
        key:"tiktok",
        name:"TikTok",
        icon:"🎵"
      },

      {
        key:"instagram",
        name:"Instagram",
        icon:"📸"
      }

    ];

    list.innerHTML =
      platforms.map(
        function(platform){

          var connected =
            !!accountData[
              platform.key
            ];

          return (

            '<div class="platform">' +

              '<div class="platform-left">' +

                '<div class="platform-icon">' +
                  platform.icon +
                '</div>' +

                '<div>' +

                  '<strong>' +
                    platform.name +
                  '</strong>' +

                  '<small>' +
                    (
                      connected
                        ? "Compte connecté"
                        : "Compte non connecté"
                    ) +
                  '</small>' +

                '</div>' +

              '</div>' +

              (
                connected

                  ? '<button disabled>✓ Connecté</button>'

                  : '<button onclick="connectAccount(\'' +
                      platform.key +
                    '\')">Connecter</button>'

              ) +

            '</div>'

          );

        }
      ).join("");

  }catch(error){

    console.log(error);

  }

}

/* =========================================================
   CONNECT ACCOUNT
========================================================= */

async function connectAccount(
  platform
){

  alert(
    "La connexion officielle " +
    platform +
    " sera branchée avec son API OAuth."
  );

}

/* =========================================================
   REVENUE
========================================================= */

async function loadRevenue(){

  try{

    var response =
      await fetch(
        "/api/revenue"
      );

    var data =
      await response.json();

    var totals =
      data.totals || {};

    document.getElementById(
      "revenueViews"
    ).textContent =
      totals.views || 0;

    document.getElementById(
      "revenueLikes"
    ).textContent =
      totals.likes || 0;

    document.getElementById(
      "revenueSubscribers"
    ).textContent =
      totals.subscribers || 0;

    document.getElementById(
      "revenueTotal"
    ).textContent =
      "$" +
      Number(
        totals.revenue || 0
      ).toFixed(2);

    var status =
      document.getElementById(
        "revenueStatus"
      );

    if(status){

      status.textContent =
        data.connected > 0
          ? data.connected +
            " compte(s) connecté(s)"
          : "Non connecté";

      status.classList.toggle(
        "off",
        data.connected === 0
      );

    }

  }catch(error){

    console.log(error);

  }

}

/* =========================================================
   TEST GEMINI
========================================================= */

async function testGemini(){

  try{

    var response =
      await fetch(
        "/api/test-gemini"
      );

    var data =
      await response.json();

    if(!response.ok){

      throw new Error(
        data.error ||
        "Gemini indisponible."
      );

    }

    alert(
      "✓ " +
      data.message +
      "\n\nTemps : " +
      data.responseTime +
      " ms"
    );

  }catch(error){

    alert(
      "Gemini : " +
      error.message
    );

  }

}

/* =========================================================
   LOAD EVERYTHING
========================================================= */

async function loadEverything(){

  await Promise.all([
    loadDashboard(),
    checkHosting(),
    loadReport(),
    loadAccounts(),
    loadRevenue()
  ]);

}

/* =========================================================
   START
========================================================= */

loadEverything();


/* JARVIS — thème futuriste bleu électrique et cyan */
function jarvisApplyTheme() {
  const panel = document.querySelector(".jarvis-panel");

  if (panel) {
    panel.style.setProperty("--jarvis-color", "#35d9ff");
  }
}

jarvisApplyTheme();

/* JARVIS — voix française optimisée */
function jarvisSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  if (!text || !String(text).trim()) return;

  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(String(text));
  utterance.lang = "fr-FR";
  utterance.rate = 0.94;
  utterance.pitch = 1.04;
  utterance.volume = 1;

  const voices = synth.getVoices();
  const frenchVoices = voices.filter(voice =>
    /^fr([-_]|$)/i.test(voice.lang)
  );

  const preferredVoice =
    frenchVoices.find(voice => /fr[-_]FR/i.test(voice.lang)) ||
    frenchVoices.find(voice =>
      /natural|neural|premium/i.test(voice.name)
    ) ||
    frenchVoices[0];

  if (preferredVoice) {
    utterance.voice = preferredVoice;
  }

  utterance.onstart = () => {
    const status = document.getElementById("jarvisStatus");
    if (status) status.textContent = "PARLE";
  };

  utterance.onend = () => {
    const status = document.getElementById("jarvisStatus");
    if (status && status.textContent === "PARLE") {
      status.textContent = "PRÊT";
    }
  };

  utterance.onerror = () => {
    const status = document.getElementById("jarvisStatus");
    if (status && status.textContent === "PARLE") {
      status.textContent = "PRÊT";
    }
  };

  synth.speak(utterance);
}


/* Entrée vocale, si le navigateur la prend en charge */
function jarvisStartVoice() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    document.getElementById("jarvisReply").textContent =
      "La reconnaissance vocale n'est pas disponible dans ce navigateur. Écris ta commande.";
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "fr-FR";
  recognition.onstart = () => {
    document.getElementById("jarvisStatus").textContent = "ÉCOUTE";
  };
  recognition.onresult = event => {
  const input = document.getElementById("jarvisInput");

  if (!input) return;

  input.value = event.results[0][0].transcript.trim();

  // Afficher la commande reconnue avant son envoi.
  const reply = document.getElementById("jarvisReply");
  if (reply) {
    reply.textContent = "Commande reconnue : " + input.value;
  }

  // Envoyer la commande dans le système existant de JARVIS.
  const form = document.getElementById("jarvisForm");
  if (form) {
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true
      }));
    }
  }
};
   recognition.onerror = () => {
    document.getElementById("jarvisReply").textContent =
      "Je n'ai pas pu comprendre. Tu peux réessayer ou écrire ta commande.";
  };
  recognition.onend = () => {
    document.getElementById("jarvisStatus").textContent = "PRÊT";
  };
  recognition.start();
}


/* JARVIS — commandes et confirmations */
let jarvisPendingAction = null;

function jarvisRespond(message, status = "PRÊT") {
  const reply = document.getElementById("jarvisReply");
  const statusNode = document.getElementById("jarvisStatus");

  if (reply) reply.textContent = message;
  if (statusNode) statusNode.textContent = status;

  if (typeof jarvisSpeak === "function") {
    jarvisSpeak(message);
  }
}

async function jarvisSend(event) {
  event.preventDefault();

  const input = document.getElementById("jarvisInput");
  const command = (input?.value || "").trim();

  if (!command) return;

  const normalized = command.toLocaleLowerCase("fr-FR");
  input.value = "";

  if (/^(aide|commandes)$/.test(normalized)) {
    jarvisRespond(
      "Commandes disponibles : créateur, projets, état du serveur, créer un projet, Auto-Pilote ou annule. Les générations nécessitent une confirmation."
    );
    return;
  }

  if (/\b(créateur|createur|ouvrir le créateur|nouveau projet)\b/.test(normalized)) {
    if (typeof go === "function") go("creator");
    jarvisRespond("Le créateur est ouvert. Décris ton idée dans son champ.");
    return;
  }

  if (/\b(projets|mes projets|ouvrir les projets)\b/.test(normalized)) {
    if (typeof go === "function") go("projects");
    jarvisRespond("J'ouvre la section des projets.");
    return;
  }

  if (/\b(état|etat|statut|serveur|diagnostic)\b/.test(normalized)) {
    try {
      const response = await fetch("/api/health");
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Serveur indisponible.");
      }

          jarvisRespond(
        "Diagnostic Cineflow : " +
        (data.message || "Serveur joignable.") +
        " Gemini : " +
        (data.geminiConnected ? "connecté." : "non connecté.") +
        " Aucun crédit de génération n'a été utilisé."
      );
    } catch (error) {
      jarvisRespond(
        "Vérification impossible : " + error.message,
        "AVERTISSEMENT"
      );
    }
    return;
  }

  if (/\b(créer|creer|générer|generer)\b/.test(normalized) &&
      /\b(projet|film|vidéo|video)\b/.test(normalized)) {
    const idea = command
      .replace(/^(jarvis[,:]?\s*)?/i, "")
      .replace(/\b(créer|creer|générer|generer)\b/i, "")
      .replace(/^\s*(un|une|le|la)?\s*(projet|film|vidéo|video)?\s*(sur|de|:)?\s*/i, "")
      .trim();

    const prompt = document.getElementById("prompt");

    if (idea && prompt) prompt.value = idea;

    if (!prompt || !prompt.value.trim()) {
      if (typeof go === "function") go("creator");
      jarvisRespond("Décris ton idée dans le créateur, puis demande de créer le projet.");
      return;
    }

    jarvisPendingAction = "create";
    jarvisRespond(
      "La création peut consommer des crédits IA. Dis « confirme la création » pour continuer ou « annule » pour arrêter.",
      "CONFIRMATION"
    );
    return;
  }

  if (/\b(auto[- ]?pilote|pilote automatique)\b/.test(normalized)) {
    jarvisPendingAction = "autopilot";
    jarvisRespond(
      "Auto-Pilote peut consommer des crédits IA. Dis « confirme auto-pilote » pour continuer ou « annule » pour arrêter.",
      "CONFIRMATION"
    );
    return;
  }

  if (/\b(annule|annuler|stop)\b/.test(normalized)) {
    jarvisPendingAction = null;
    jarvisRespond("Action annulée. Aucune génération n'a été lancée.");
    return;
  }

  if (/\b(confirme la création|confirme la creation)\b/.test(normalized) &&
      jarvisPendingAction === "create") {
    jarvisPendingAction = null;
    jarvisRespond("Confirmation reçue. Lancement de la création.", "EN COURS");

    if (typeof createProject === "function") {
      await createProject();
    } else {
      jarvisRespond("La fonction de création est introuvable.", "AVERTISSEMENT");
    }
    return;
  }

  if (/\b(confirme auto[- ]?pilote|confirme le pilote automatique)\b/.test(normalized) &&
      jarvisPendingAction === "autopilot") {
    jarvisPendingAction = null;
    jarvisRespond("Confirmation reçue. Lancement d'Auto-Pilote.", "EN COURS");

    if (typeof autopilot === "function") {
      await autopilot();
    } else {
      jarvisRespond("La fonction Auto-Pilote est introuvable.", "AVERTISSEMENT");
    }
    return;
  }

const suggestions = [
  "Je peux t'aider à préparer une histoire de film.",
  "Je peux t'aider à organiser les scènes de ton projet.",
  "Je peux vérifier l'état du serveur Cineflow.",
  "Je peux ouvrir le créateur ou afficher tes projets."
];

const suggestion =
  suggestions[Math.floor(Math.random() * suggestions.length)];

jarvisRespond(
  "Je n'ai pas reconnu cette commande. " + suggestion +
  " Dis « aide » pour afficher les commandes disponibles."
);
}


</script>

</body>
</html>`;
}

/* =========================================================
   HOME
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.send(
      getHomePage()
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      "========================================"
    );

    console.log(
      "          CINEFLOW IS RUNNING"
    );

    console.log(
      "========================================"
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Gemini:",
      API_KEY
        ? "CONNECTED"
        : "MISSING KEY"
    );

    console.log(
      "Text model:",
      MODEL
    );

    console.log(
      "Image model:",
      IMAGE_MODEL
    );

    console.log(
      "Video model:",
      VIDEO_MODEL
    );

    console.log(
      "========================================"
    );

  }
);
