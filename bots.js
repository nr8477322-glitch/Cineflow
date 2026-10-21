
const express = require("express");

module.exports = function createBotsRouter(options) {
  const router = express.Router();

  const {
    projects,
    jobs,
    generatedImages,
        generatedVideos,
    pool,
    databaseReady,
    providers,
    retryScene
  } = options;
    router.get("/status", (req, res) => {
    res.json({
      success: true,
      orchestrator: {
        name: "Cineflow Orchestre",
        status: "ready_for_planning"
      },
      bots: [
        { name: "Gestionnaire de quotas", status: "initializing" },
        { name: "Scénariste", status: "existing_engine" },
        { name: "Réalisateur", status: "existing_engine" },
        { name: "Animateur", status: "existing_engine" },
        { name: "Son et montage", status: "existing_engine" },
        { name: "Contrôle qualité", status: "planned" },
        { name: "File d'attente et reprise", status: "planned" }
      ],
      providers,
      activity: {
        projectsInMemory: projects.length,
        jobsInMemory: jobs.size,
        imagesInMemory: generatedImages.size,
        videosInMemory: generatedVideos.size
      },
      quota: {
        videosPossible: null,
        status: "not_yet_measured",
        message:
          "Le suivi des consommations doit être connecté avant de calculer un nombre fiable de vidéos."
      }
    });
  });

router.get("/quota", (req, res) => {
  const configuredProviders = {
    gemini: Boolean(providers && providers.gemini),
    magicHour: Boolean(providers && providers.magicHour),
    cloudflare: Boolean(providers && providers.cloudflare)
  };

  return res.json({
    success: true,
    bot: "Gestionnaire de quotas et de budget",
    status: "estimate_ready_tracking_not_connected",
    providers: configuredProviders,
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
        "Les clés détectées ne révèlent pas les quotas restants. Les consommations réelles et les tarifs doivent être connectés avant d'annoncer un nombre fiable de vidéos."
    },
    nextStep:
      "Utiliser POST /api/bots/quota/estimate avec les quotas restants connus pour calculer une estimation, sans lancer de génération."
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

  const videosPossible = Math.min(
    scriptVideos,
    imageVideos,
    animationVideos
  );

  return res.json({
    success: true,
    bot: "Gestionnaire de quotas et de budget",
    estimate: {
      videosPossible,
      basedOn: {
        scriptCallsRemaining: req.body.scriptCallsRemaining,
        imageCallsRemaining: req.body.imageCallsRemaining,
        animationCallsRemaining: req.body.animationCallsRemaining,
        scenesPerVideo: 5
      },
      verifiedByProvider: false
    },
    warning:
      "Estimation basée uniquement sur les nombres fournis. Cineflow ne vérifie pas encore ces quotas auprès des fournisseurs et ne compte pas automatiquement les appels réels."
  });
});


const recoveryQueue = new Map();

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
        "SELECT data FROM cineflow_recovery_queue ORDER BY updated_at ASC"
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

  router.get("/queue", async (req, res) => {
    const persistent = await queueTableReady;

    try {
      let tasks = Array.from(recoveryQueue.values());

      if (persistent) {
        const result = await pool.query(
          "SELECT data FROM cineflow_recovery_queue ORDER BY updated_at ASC"
        );

        tasks = result.rows.map(row => row.data);

        for (const task of tasks) {
          if (task && task.id) {
            recoveryQueue.set(task.id, task);
          }
        }
      }

      return res.json({
        success: true,
        bot: "File d'attente et de reprise",
        status: "ready",
        storage: persistent ? "neon" : "memory",
        persistent,
        tasks,
        total: tasks.length,
        message: persistent
        ? "Les tâches sont sauvegardées dans Neon. La reprise automatique est activée."
          : "Neon n'est pas disponible pour la file. Les tâches en mémoire peuvent disparaître au redémarrage."
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
      !Number.isInteger(sceneNumber) ||
      sceneNumber < 1
    ) {
      return res.status(400).json({
        success: false,
        error: "Fournis projectId et un sceneNumber entier supérieur à zéro."
      });
    }

    const persistent = await queueTableReady;
    const taskId = `${projectId.trim()}:scene:${sceneNumber}`;

    try {
      if (persistent) {
        const existing = await pool.query(
          "SELECT data FROM cineflow_recovery_queue WHERE id = $1",
          [taskId]
        );

        if (existing.rows.length > 0) {
          recoveryQueue.set(taskId, existing.rows[0].data);

          return res.json({
            success: true,
            duplicate: true,
            task: existing.rows[0].data,
            message: "Cette scène est déjà dans la file."
          });
        }
      } else if (recoveryQueue.has(taskId)) {
        return res.json({
          success: true,
          duplicate: true,
          task: recoveryQueue.get(taskId),
          message: "Cette scène est déjà dans la file."
        });
      }

      const task = {
        id: taskId,
        projectId: projectId.trim(),
        sceneNumber,
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString()
      };

      if (persistent) {
        const inserted = await pool.query(
          `INSERT INTO cineflow_recovery_queue
            (id, project_id, scene_number, status, attempts, data, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
           ON CONFLICT (id) DO NOTHING
           RETURNING data`,
          [
            task.id,
            task.projectId,
            task.sceneNumber,
            task.status,
            task.attempts,
            JSON.stringify(task)
          ]
        );

        if (inserted.rows.length === 0) {
          const existing = await pool.query(
            "SELECT data FROM cineflow_recovery_queue WHERE id = $1",
            [taskId]
          );

          if (existing.rows.length > 0) {
            const existingTask = existing.rows[0].data;
            recoveryQueue.set(taskId, existingTask);

            return res.json({
              success: true,
              duplicate: true,
              task: existingTask,
              message: "Cette scène est déjà dans la file."
            });
          }
        }
      }

      recoveryQueue.set(taskId, task);

      return res.status(201).json({
        success: true,
        task,
        storage: persistent ? "neon" : "memory",
        persistent,
        message: persistent
          ? "Scène ajoutée et sauvegardée dans Neon. Aucune génération lancée."
          : "Scène ajoutée en mémoire. Aucune génération lancée."
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
    const persistent = await queueTableReady;

    try {
      let task = recoveryQueue.get(req.params.taskId);

      if (persistent) {
        const result = await pool.query(
          "SELECT data FROM cineflow_recovery_queue WHERE id = $1",
          [req.params.taskId]
        );
        task = result.rows[0]?.data;
      }

      if (!task) {
        return res.status(404).json({
          success: false,
          error: "Tâche introuvable dans la file."
        });
      }

      if (typeof retryScene !== "function") {
        return res.status(503).json({
          success: false,
          error: "Le moteur de reprise n'est pas connecté."
        });
      }

      const result = await retryScene(
        task.projectId,
        task.sceneNumber,
        task
      );

      if (!result || result.success !== true) {
        return res.status(409).json({
          success: false,
          error: result?.error || "La scène ne peut pas être relancée."
        });
      }

      task = {
        ...task,
        status: "processing",
        attempts: (Number.isInteger(task.attempts) ? task.attempts : 0) + 1,
        videoId: result.videoId,
        lastRetryRequestedAt: new Date().toISOString()
      };

      if (persistent) {
        await pool.query(
          `UPDATE cineflow_recovery_queue
           SET status = $2,
               attempts = $3,
               data = $4::jsonb,
               updated_at = NOW()
           WHERE id = $1`,
          [
            task.id,
            task.status,
            task.attempts,
            JSON.stringify(task)
          ]
        );
      }

      recoveryQueue.set(task.id, task);

      return res.json({
        success: true,
        task,
        storage: persistent ? "neon" : "memory",
        persistent,
        message: "La relance de la scène a été démarrée."
      });
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
    if (!projectId || !Number.isInteger(Number(sceneNumber))) {
      return false;
    }

    const persistent = await queueTableReady;
    const taskId = `${projectId}:scene:${Number(sceneNumber)}`;
    const previous = recoveryQueue.get(taskId);

    const task = {
      ...(previous || {}),
      id: taskId,
      projectId,
      sceneNumber: Number(sceneNumber),
      status: "queued",
      attempts: Number.isInteger(previous?.attempts)
        ? previous.attempts
        : 0,
      videoId: videoId || previous?.videoId || null,
      lastError: error || previous?.lastError || null,
      updatedAt: new Date().toISOString()
    };

    if (persistent) {
      await pool.query(
        `INSERT INTO cineflow_recovery_queue
          (id, project_id, scene_number, status, attempts, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           attempts = EXCLUDED.attempts,
           data = EXCLUDED.data,
           updated_at = NOW()`,
        [
          task.id,
          task.projectId,
          task.sceneNumber,
          task.status,
          task.attempts,
          JSON.stringify(task)
        ]
      );
    }

    recoveryQueue.set(taskId, task);
    return true;
  };

  router.updateRecoveryTask = async ({
    projectId,
    sceneNumber,
    status,
    videoId,
    error
  }) => {
    const taskId = `${projectId}:scene:${Number(sceneNumber)}`;
    const persistent = await queueTableReady;
    let task = recoveryQueue.get(taskId);

    if (persistent) {
      const result = await pool.query(
        "SELECT data FROM cineflow_recovery_queue WHERE id = $1",
        [taskId]
      );

      if (result.rows[0]?.data) {
        task = result.rows[0].data;
      }
    }

    if (!task) return false;

    task = {
      ...task,
      status,
      videoId: videoId || task.videoId || null,
      ...(error ? { lastError: error } : {}),
      updatedAt: new Date().toISOString()
    };

    if (persistent) {
      await pool.query(
        `UPDATE cineflow_recovery_queue
         SET status = $2,
             data = $3::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [taskId, status, JSON.stringify(task)]
      );
    }

    recoveryQueue.set(taskId, task);
    return true;
  };
  router.post("/orchestrate", async (req, res) => {
    try {
      const projectId = req.body.projectId;

      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: "Indique l'identifiant du projet."
        });
      }

      let project = projects.find(
        item => item.id === projectId
      );

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

      const countAssets = (field, collection) => {
        const assets = project[field];

        if (Array.isArray(assets)) {
          return assets.length;
        }

        if (assets && typeof assets === "object") {
          return Object.keys(assets).length;
        }

        let count = 0;

        for (const asset of collection.values()) {
          if (asset && asset.projectId === projectId) {
            count++;
          }
        }

        return count;
      };

      const imageCount = countAssets(
        "images",
        generatedImages
      );

      const videoCount = countAssets(
        "videos",
        generatedVideos
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
            status: "to_check"
          }
        ],
        note:
          "Planification uniquement : aucune génération n'a été lancée."
      });
    } catch (error) {
      console.error("Bot Orchestre :", error.message);

      return res.status(500).json({
        success: false,
        error: "Impossible de préparer le plan de production."
      });
    }
  });


  const MAX_AUTO_RECOVERY_ATTEMPTS = 3;
  let recoveryWorkerRunning = false;

  async function saveRecoveryTask(task, persistent) {
    task.updatedAt = new Date().toISOString();
    recoveryQueue.set(task.id, task);

    if (persistent) {
      await pool.query(
        `UPDATE cineflow_recovery_queue
         SET status = $2,
             attempts = $3,
             data = $4::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          task.id,
          task.status,
          task.attempts,
          JSON.stringify(task)
        ]
      );
    }
  }

  async function processRecoveryQueue() {
    if (recoveryWorkerRunning) return;

    recoveryWorkerRunning = true;

    try {
      const persistent = await queueTableReady;

      if (typeof retryScene !== "function") {
        console.error(
          "Bot de reprise : retryScene n'est pas connecté."
        );
        return;
      }

      const pendingTasks = Array.from(
        recoveryQueue.values()
      ).filter(
        task => task && task.status === "queued"
      );

      for (const task of pendingTasks) {
        if (recoveryQueue.get(task.id)?.status !== "queued") {
          continue;
        }

        if (
          Number(task.attempts || 0) >=
          MAX_AUTO_RECOVERY_ATTEMPTS
        ) {
          task.status = "failed";
          task.lastError =
            task.lastError ||
            "Nombre maximal de tentatives atteint.";

          await saveRecoveryTask(task, persistent);
          continue;
        }

        task.status = "processing";
        task.attempts =
          Number(task.attempts || 0) + 1;

        await saveRecoveryTask(task, persistent);

        try {
          const result = await retryScene(
            task.projectId,
            task.sceneNumber,
            task
          );

          if (!result || result.success !== true) {
            const latestTask =
              recoveryQueue.get(task.id) || task;

            latestTask.status =
              task.attempts >= MAX_AUTO_RECOVERY_ATTEMPTS
                ? "failed"
                : "queued";

            latestTask.lastError =
              result?.error ||
              "La relance automatique a échoué.";

            await saveRecoveryTask(
              latestTask,
              persistent
            );
          }
          // Si la relance démarre, le moteur vidéo
          // gère ensuite l'état de la tâche.
        } catch (error) {
          const latestTask =
            recoveryQueue.get(task.id) || task;

          latestTask.status =
            task.attempts >= MAX_AUTO_RECOVERY_ATTEMPTS
              ? "failed"
              : "queued";

          latestTask.lastError =
            error.message ||
            "Erreur pendant la reprise automatique.";

          await saveRecoveryTask(
            latestTask,
            persistent
          );
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


  setInterval(() => {
    processRecoveryQueue();
  }, 60 * 1000);

  return router;
};
