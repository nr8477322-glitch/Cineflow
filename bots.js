
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
    providers
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

  return router;
};
