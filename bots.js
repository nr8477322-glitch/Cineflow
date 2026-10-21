
const express = require("express");

module.exports = function createBotsRouter(options) {
  const router = express.Router();

  const {
    projects = [],
    jobs = new Map(),
    generatedImages = new Map(),
    generatedVideos = new Map(),
    pool,
    databaseReady,
    providers = {},
    retryScene
  } = options || {};

  const recoveryQueue = new Map();
  const activeRetries = new Set();

  const MAX_AUTO_RECOVERY_ATTEMPTS = 3;
  const STALE_TASK_TIMEOUT_MS = 15 * 60 * 1000;

  let recoveryWorkerRunning = false;

  function taskIdFor(projectId, sceneNumber) {
    return `${projectId}:scene:${Number(sceneNumber)}`;
  }

  function isValidSceneNumber(value) {
    return Number.isInteger(Number(value)) && Number(value) >= 1;
  }

  function timestamp() {
    return new Date().toISOString();
  }

  function getTaskAge(task) {
    const date = Date.parse(task.updatedAt || task.createdAt || "");
    return Number.isFinite(date) ? Date.now() - date : Infinity;
  }

  async function persistTask(task) {
    task.updatedAt = timestamp();
    recoveryQueue.set(task.id, task);

    if (!pool || !(await queueTableReady)) {
      return false;
    }

    await pool.query(
      `INSERT INTO cineflow_recovery_queue
        (id, project_id, scene_number, status, attempts, data, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         scene_number = EXCLUDED.scene_number,
         status = EXCLUDED.status,
         attempts = EXCLUDED.attempts,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [
        task.id,
        task.projectId,
        task.sceneNumber,
        task.status,
        Number(task.attempts || 0),
        JSON.stringify(task)
      ]
    );

    return true;
  }

  const queueTableReady = (async () => {
    if (!pool) return false;

    try {
      const ready = await databaseReady;
      if (!ready) return false;

      await pool.query(`
        CREATE TABLE IF NOT EXISTS cineflow_recovery_queue (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          scene_number INTEGER NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const result = await pool.query(
        `SELECT data
         FROM cineflow_recovery_queue
         ORDER BY updated_at ASC`
      );

      for (const row of result.rows) {
        if (row.data && row.data.id) {
          recoveryQueue.set(row.data.id, row.data);
        }
      }

      console.log("File de reprise : sauvegarde Neon prête.");

      return true;
    } catch (error) {
      console.error("File de reprise Neon :", error.message);
      return false;
    }
  })();

  // Remet en file les tâches probablement interrompues.
  // Une tâche en traitement depuis 15 minutes ou plus
  // est considérée comme potentiellement interrompue.
  async function recoverStaleTasks() {
    const persistent = await queueTableReady;
    if (!persistent) return;

    for (const task of recoveryQueue.values()) {
      if (task.status !== "processing") continue;
      if (getTaskAge(task) < STALE_TASK_TIMEOUT_MS) continue;

      task.status = "queued";
      task.lastError =
        "Tâche remise en file après une interruption possible du serveur.";

      await persistTask(task);
    }
  }

  router.get("/status", (req, res) => {
    const tasks = Array.from(recoveryQueue.values());

    res.json({
      success: true,
      orchestrator: {
        name: "Cineflow Orchestre",
        status: "ready_for_planning"
      },
      bots: [
        { name: "Gestionnaire de quotas", status: "estimate_only" },
        { name: "Scénariste", status: "existing_engine" },
        { name: "Réalisateur", status: "existing_engine" },
        { name: "Animateur", status: "server_engine_required" },
        { name: "Son et montage", status: "server_engine_required" },
        { name: "Contrôle qualité", status: "planned" },
        { name: "File d'attente et reprise", status: "active" }
      ],
      providers,
      activity: {
        projectsInMemory: projects.length,
        jobsInMemory: jobs.size,
        imagesInMemory: generatedImages.size,
        videosInMemory: generatedVideos.size
      },
      recovery: {
        total: tasks.length,
        queued: tasks.filter(t => t.status === "queued").length,
        processing: tasks.filter(t => t.status === "processing").length,
        failed: tasks.filter(t => t.status === "failed").length,
        completed: tasks.filter(t => t.status === "completed").length,
        maxAttempts: MAX_AUTO_RECOVERY_ATTEMPTS
      },
      quota: {
        videosPossible: null,
        status: "not_yet_measured",
        verifiedByProvider: false,
        message:
          "Les quotas restants doivent être vérifiés auprès des fournisseurs."
      }
    });
  });

  router.get("/quota", (req, res) => {
    res.json({
      success: true,
      bot: "Gestionnaire de quotas et de budget",
      status: "estimate_only",
      providers: {
        gemini: Boolean(providers.gemini),
        magicHour: Boolean(providers.magicHour),
        cloudflare: Boolean(providers.cloudflare)
      },
      productionModel: {
        scenesPerVideo: 5,
        scriptCallsPerVideo: 1,
        imageCallsPerVideo: 5,
        animationCallsPerVideo: 5
      },
      currentActivity: {
        projectsInMemory: projects.length,
        jobsInMemory: jobs.size,
        imagesInMemory: generatedImages.size,
        videosInMemory: generatedVideos.size
      },
      quota: {
        videosPossible: null,
        verifiedRemainingQuota: false,
        message:
          "La présence d'une clé API ne confirme pas le quota disponible ni le coût réel."
      }
    });
  });

  router.post("/quota/estimate", (req, res) => {
    const fields = [
      "scriptCallsRemaining",
      "imageCallsRemaining",
      "animationCallsRemaining"
    ];

    for (const field of fields) {
      const value = req.body && req.body[field];

      if (!Number.isInteger(value) || value < 0) {
        return res.status(400).json({
          success: false,
          error:
            "Fournis des nombres entiers positifs ou nuls pour scriptCallsRemaining, imageCallsRemaining et animationCallsRemaining."
        });
      }
    }

    const scriptVideos = req.body.scriptCallsRemaining;
    const imageVideos = Math.floor(
      req.body.imageCallsRemaining / 5
    );
    const animationVideos = Math.floor(
      req.body.animationCallsRemaining / 5
    );

    return res.json({
      success: true,
      bot: "Gestionnaire de quotas et de budget",
      estimate: {
        videosPossible: Math.min(
          scriptVideos,
          imageVideos,
          animationVideos
        ),
        basedOn: {
          scriptCallsRemaining: scriptVideos,
          imageCallsRemaining: req.body.imageCallsRemaining,
          animationCallsRemaining: req.body.animationCallsRemaining,
          scenesPerVideo: 5
        },
        verifiedByProvider: false
      },
      warning:
        "Cette estimation utilise les nombres fournis. Elle ne lit pas les quotas réels des fournisseurs."
    });
  });

  router.get("/queue", async (req, res) => {
    try {
      const persistent = await queueTableReady;

      if (persistent) {
        const result = await pool.query(
          `SELECT data
           FROM cineflow_recovery_queue
           ORDER BY updated_at ASC`
        );

        for (const row of result.rows) {
          if (row.data && row.data.id) {
            recoveryQueue.set(row.data.id, row.data);
          }
        }
      }

      const tasks = Array.from(recoveryQueue.values());

      return res.json({
        success: true,
        bot: "File d'attente et de reprise",
        status: "ready",
        storage: persistent ? "neon" : "memory",
        persistent,
        tasks,
        total: tasks.length,
        message: persistent
          ? "Les tâches sont sauvegardées dans Neon."
          : "Les tâches sont conservées en mémoire et peuvent disparaître au redémarrage."
      });
    } catch (error) {
      console.error("Lecture de la file :", error.message);

      return res.status(500).json({
        success: false,
        error: "Impossible de lire la file d'attente."
      });
    }
  });

  router.post("/queue", async (req, res) => {
    const { projectId, sceneNumber } = req.body || {};

    if (
      typeof projectId !== "string" ||
      !projectId.trim() ||
      !isValidSceneNumber(sceneNumber)
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Fournis projectId et un sceneNumber entier supérieur à zéro."
      });
    }

    const cleanProjectId = projectId.trim();
    const number = Number(sceneNumber);
    const id = taskIdFor(cleanProjectId, number);

    try {
      const persistent = await queueTableReady;

      let existing = recoveryQueue.get(id);

      if (persistent) {
        const result = await pool.query(
          "SELECT data FROM cineflow_recovery_queue WHERE id = $1",
          [id]
        );

        if (result.rows.length > 0) {
          existing = result.rows[0].data;
        }
      }

      if (
        existing &&
        ["queued", "processing", "completed"].includes(existing.status)
      ) {
        recoveryQueue.set(id, existing);

        return res.json({
          success: true,
          duplicate: true,
          task: existing,
          message: "Cette scène possède déjà une tâche active ou terminée."
        });
      }

      const task = {
        ...(existing || {}),
        id,
        projectId: cleanProjectId,
        sceneNumber: number,
        status: "queued",
        attempts: Number(existing?.attempts || 0),
        createdAt: existing?.createdAt || timestamp(),
        updatedAt: timestamp()
      };

      await persistTask(task);

      return res.status(201).json({
        success: true,
        task,
        storage: persistent ? "neon" : "memory",
        persistent,
        message: "Scène ajoutée à la file. La génération n'est pas lancée par cette route."
      });
    } catch (error) {
      console.error("Ajout à la file :", error.message);

      return res.status(500).json({
        success: false,
        error: "Impossible d'ajouter la scène à la file."
      });
    }
  });

  router.post("/queue/:taskId/retry", async (req, res) => {
    const id = req.params.taskId;

    try {
      const persistent = await queueTableReady;
      let task = recoveryQueue.get(id);

      if (persistent) {
        const result = await pool.query(
          "SELECT data FROM cineflow_recovery_queue WHERE id = $1",
          [id]
        );

        task = result.rows[0]?.data;
      }

      if (!task) {
        return res.status(404).json({
          success: false,
          error: "Tâche introuvable dans la file."
        });
      }

      if (task.status === "processing" || activeRetries.has(id)) {
        return res.status(409).json({
          success: false,
          error: "Cette scène est déjà en cours de traitement."
        });
      }

      if (task.status === "completed") {
        return res.status(409).json({
          success: false,
          error: "Cette scène est déjà marquée comme terminée."
        });
      }

      if (typeof retryScene !== "function") {
        return res.status(503).json({
          success: false,
          error: "Le moteur de reprise n'est pas connecté."
        });
      }

      if (Number(task.attempts || 0) >= MAX_AUTO_RECOVERY_ATTEMPTS) {
        return res.status(409).json({
          success: false,
          error: "Le nombre maximal de tentatives a été atteint."
        });
      }

      activeRetries.add(id);

      task.status = "processing";
      task.attempts = Number(task.attempts || 0) + 1;
      task.lastRetryRequestedAt = timestamp();

      await persistTask(task);

      try {
        const result = await retryScene(
          task.projectId,
          task.sceneNumber,
          task
        );

        if (!result || result.success !== true) {
          task.status = "queued";
          task.lastError =
            result?.error || "Le moteur n'a pas pu démarrer la scène.";

          await persistTask(task);

          return res.status(409).json({
            success: false,
            task,
            error: task.lastError
          });
        }

        task.videoId = result.videoId || task.videoId || null;
        await persistTask(task);

        return res.json({
          success: true,
          task,
          storage: persistent ? "neon" : "memory",
          persistent,
          message:
            "La relance a été demandée. Le résultat final dépend du suivi du moteur vidéo."
        });
      } finally {
        activeRetries.delete(id);
      }
    } catch (error) {
      console.error("Relance de scène :", error.message);

      return res.status(500).json({
        success: false,
        error: "Impossible de relancer cette scène."
      });
    }
  });

  router.enqueueRecoveryTask = async ({
    projectId,
    sceneNumber,
    videoId,
    error
  }) => {
    if (!projectId || !isValidSceneNumber(Number(sceneNumber))) {
      return false;
    }

    const number = Number(sceneNumber);
    const id = taskIdFor(projectId, number);
    const persistent = await queueTableReady;

    let previous = recoveryQueue.get(id);

    if (persistent) {
      const result = await pool.query(
        "SELECT data FROM cineflow_recovery_queue WHERE id = $1",
        [id]
      );

      if (result.rows[0]?.data) {
        previous = result.rows[0].data;
      }
    }

    if (previous?.status === "completed") {
      return false;
    }

    const task = {
      ...(previous || {}),
      id,
      projectId,
      sceneNumber: number,
      status: "queued",
      attempts: Number(previous?.attempts || 0),
      videoId: videoId || previous?.videoId || null,
      lastError: error || previous?.lastError || null,
      createdAt: previous?.createdAt || timestamp(),
      updatedAt: timestamp()
    };

    await persistTask(task);

    return true;
  };

  router.updateRecoveryTask = async ({
    projectId,
    sceneNumber,
    status,
    videoId,
    error
  }) => {
    const id = taskIdFor(projectId, sceneNumber);
    const persistent = await queueTableReady;

    let task = recoveryQueue.get(id);

    if (persistent) {
      const result = await pool.query(
        "SELECT data FROM cineflow_recovery_queue WHERE id = $1",
        [id]
      );

      if (result.rows[0]?.data) {
        task = result.rows[0].data;
      }
    }

    if (!task) return false;

    task.status = status;
    task.videoId = videoId || task.videoId || null;
    task.updatedAt = timestamp();

    if (error) {
      task.lastError = error;
    }

    await persistTask(task);

    return true;
  };

  router.post("/orchestrate", async (req, res) => {
    try {
      const projectId = req.body?.projectId;

      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: "Indique l'identifiant du projet."
        });
      }

      let project = projects.find(item => item.id === projectId);

      if (pool) {
        await databaseReady;

        const result = await pool.query(
          "SELECT data FROM cineflow_projects WHERE id = $1",
          [projectId]
        );

        if (result.rows.length > 0) {
          project = result.rows[0].data;
        }
      }

      if (!project) {
        return res.status(404).json({
          success: false,
          error: "Projet introuvable."
        });
      }

      const scenes = Array.isArray(project.scenes)
        ? project.scenes
        : [];

      function countAssets(field, collection) {
        const assets = project[field];

        if (Array.isArray(assets)) return assets.length;
        if (assets && typeof assets === "object") {
          return Object.keys(assets).length;
        }

        let count = 0;

        for (const asset of collection.values()) {
          if (asset && asset.projectId === projectId) count++;
        }

        return count;
      }

      const imageCount = countAssets("images", generatedImages);
      const videoCount = countAssets("videos", generatedVideos);

      const tasks = Array.from(recoveryQueue.values()).filter(
        task => task.projectId === projectId
      );

      return res.json({
        success: true,
        orchestrator: "Cineflow Orchestre",
        project: {
          id: project.id,
          title: project.title || "Sans titre",
          sceneCount: scenes.length
        },
        plan: [
          {
            task: "Vérifier le scénario",
            status: scenes.length ? "ready" : "pending"
          },
          {
            task: "Vérifier les images",
            completed: imageCount,
            expected: scenes.length
          },
          {
            task: "Vérifier les animations",
            completed: videoCount,
            expected: scenes.length
          },
          {
            task: "Vérifier le son",
            status: project.audio?.status || "to_check"
          },
          {
            task: "Contrôler le montage final",
            status: project.finalVideo?.status || "to_check"
          },
          {
            task: "File de reprise",
            queued: tasks.filter(t => t.status === "queued").length,
            processing: tasks.filter(t => t.status === "processing").length,
            failed: tasks.filter(t => t.status === "failed").length
          }
        ],
        note:
          "Cette route vérifie l'état et prépare un plan. Elle ne lance pas elle-même la génération audio ou le montage."
      });
    } catch (error) {
      console.error("Bot Orchestre :", error.message);

      return res.status(500).json({
        success: false,
        error: "Impossible de préparer le plan de production."
      });
    }
  });

  async function processRecoveryQueue() {
    if (recoveryWorkerRunning) return;

    recoveryWorkerRunning = true;

    try {
      const persistent = await queueTableReady;

      if (persistent) {
        const result = await pool.query(
          `SELECT data
           FROM cineflow_recovery_queue
           WHERE status IN ('queued', 'processing')
           ORDER BY updated_at ASC`
        );

        for (const row of result.rows) {
          if (row.data?.id) {
            recoveryQueue.set(row.data.id, row.data);
          }
        }

        await recoverStaleTasks();
      }

      if (typeof retryScene !== "function") {
        console.error(
          "Bot de reprise : retryScene n'est pas connecté."
        );
        return;
      }

      const pendingTasks = Array.from(recoveryQueue.values()).filter(
        task => task && task.status === "queued"
      );

      for (const task of pendingTasks) {
        const id = task.id;

        if (activeRetries.has(id)) continue;
        if (recoveryQueue.get(id)?.status !== "queued") continue;

        if (Number(task.attempts || 0) >= MAX_AUTO_RECOVERY_ATTEMPTS) {
          task.status = "failed";
          task.lastError =
            task.lastError || "Nombre maximal de tentatives atteint.";

          await persistTask(task);
          continue;
        }

        activeRetries.add(id);

        task.status = "processing";
        task.attempts = Number(task.attempts || 0) + 1;

        await persistTask(task);

        try {
          const result = await retryScene(
            task.projectId,
            task.sceneNumber,
            task
          );

        
if (!result || result.success !== true) {
  const errorMessage =
    result?.error || "La relance automatique a échoué.";

  const permanentError =
    result?.permanent === true ||
    errorMessage.includes(
      "Projet introuvable dans la mémoire et dans Neon"
    ) ||
    errorMessage.includes(
      "Image de cette scène indisponible en mémoire"
    );

  task.status =
    permanentError ||
    task.attempts >= MAX_AUTO_RECOVERY_ATTEMPTS
      ? "failed"
      : "queued";

  task.lastError = errorMessage;

  await persistTask(task);
} else {
  task.videoId = result.videoId || task.videoId || null;
  await persistTask(task);
}

        } catch (error) {
          task.status =
            task.attempts >= MAX_AUTO_RECOVERY_ATTEMPTS
              ? "failed"
              : "queued";

          task.lastError =
            error.message || "Erreur pendant la reprise automatique.";

          await persistTask(task);
        } finally {
          activeRetries.delete(id);
        }
      }
    } catch (error) {
      console.error(
        "Bot de reprise automatique :",
        error.message
      );
    } finally {
      recoveryWorkerRunning = false;
    }
  }

  // Démarrer une vérification au lancement, puis toutes les minutes.
  queueTableReady
    .then(() => processRecoveryQueue())
    .catch(error => {
      console.error("Initialisation de la file :", error.message);
    });

  setInterval(() => {
    processRecoveryQueue();
  }, 60 * 1000);

  return router;
};
