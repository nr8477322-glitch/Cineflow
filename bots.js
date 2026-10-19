
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
