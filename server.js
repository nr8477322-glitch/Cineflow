const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const app = express();

/*
=========================================================
CONFIGURATION
=========================================================
*/

app.use(express.json({ limit: "30mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

const MODEL = "gemini-3.8-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";
const VIDEO_MODEL = "veo-3.1-generate-preview";

if (!API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY n'est pas configurée.");
}

const ai = new GoogleGenAI({
  apiKey: API_KEY
});


/*
=========================================================
OUTILS
=========================================================
*/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function cleanJson(text) {
  if (!text) {
    throw new Error("Gemini n'a retourné aucune donnée.");
  }

  let value = String(text).trim();

  value = value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const objectStart = value.indexOf("{");
  const arrayStart = value.indexOf("[");

  let start = -1;

  if (objectStart === -1) {
    start = arrayStart;
  } else if (arrayStart === -1) {
    start = objectStart;
  } else {
    start = Math.min(objectStart, arrayStart);
  }

  if (start === -1) {
    throw new Error("Réponse JSON introuvable.");
  }

  const lastObject = value.lastIndexOf("}");
  const lastArray = value.lastIndexOf("]");

  const end = Math.max(lastObject, lastArray);

  if (end === -1 || end <= start) {
    throw new Error("JSON incomplet reçu de Gemini.");
  }

  return value.substring(start, end + 1);
}


function getInteractionText(interaction) {
  if (!interaction) return "";

  if (typeof interaction.output_text === "string") {
    return interaction.output_text;
  }

  if (typeof interaction.outputText === "string") {
    return interaction.outputText;
  }

  if (Array.isArray(interaction.steps)) {
    let text = "";

    for (const step of interaction.steps) {
      if (!step) continue;

      if (Array.isArray(step.content)) {
        for (const block of step.content) {
          if (
            block &&
            block.type === "text" &&
            typeof block.text === "string"
          ) {
            text += block.text;
          }
        }
      }
    }

    return text;
  }

  return "";
}


/*
=========================================================
GEMINI TEXTE
=========================================================
*/

async function generateTextInteraction(input, responseFormat) {
  let lastError = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const interaction = await ai.interactions.create({
        model: MODEL,
        input,
        response_format: responseFormat
      });

      return interaction;

    } catch (error) {
      lastError = error;

      console.error(
        `Gemini tentative ${attempt}/4 :`,
        error?.message || error
      );

      if (attempt < 4) {
        await sleep(1500 * attempt);
      }
    }
  }

  throw lastError || new Error("Impossible de contacter Gemini.");
}


/*
=========================================================
GÉNÉRATION IMAGE
=========================================================
*/

async function generateImage(prompt) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const interaction = await ai.interactions.create({
        model: IMAGE_MODEL,
        input: prompt,
        response_format: {
          type: "image",
          mime_type: "image/png",
          aspect_ratio: "16:9",
          image_size: "1K"
        }
      });

      if (
        interaction &&
        interaction.output_image &&
        interaction.output_image.data
      ) {
        return {
          mimeType:
            interaction.output_image.mime_type ||
            interaction.output_image.mimeType ||
            "image/png",
          data: interaction.output_image.data
        };
      }

      if (Array.isArray(interaction?.steps)) {
        for (const step of interaction.steps) {
          if (!Array.isArray(step?.content)) continue;

          for (const block of step.content) {
            if (
              block &&
              block.type === "image" &&
              typeof block.data === "string"
            ) {
              return {
                mimeType:
                  block.mime_type ||
                  block.mimeType ||
                  "image/png",
                data: block.data
              };
            }
          }
        }
      }

      throw new Error(
        "Gemini a répondu mais aucune image n'a été trouvée."
      );

    } catch (error) {
      lastError = error;

      console.error(
        `Image tentative ${attempt}/3 :`,
        error?.message || error
      );

      if (attempt < 3) {
        await sleep(2000 * attempt);
      }
    }
  }

  throw lastError || new Error("Impossible de générer l'image.");
}


/*
=========================================================
GÉNÉRATION VIDÉO VEO 3.1
=========================================================
*/

async function generateVideoFromImage(image, prompt) {

  if (!image?.data) {
    throw new Error("Image de scène manquante.");
  }

  const imageData = String(image.data)
    .replace(/^data:[^;]+;base64,/, "");

  if (!imageData) {
    throw new Error("Image de scène invalide.");
  }

  console.log("🎞️ Envoi de la scène à Veo...");

  let operation = await ai.models.generateVideos({
    model: VIDEO_MODEL,

    prompt: prompt,

    image: {
      imageBytes: imageData,
      mimeType: image.mimeType || "image/png"
    },

    config: {
      aspectRatio: "16:9"
    }
  });

  while (!operation.done) {

    console.log(
      "⏳ Veo travaille encore..."
    );

    await sleep(10000);

    operation =
      await ai.operations.getVideosOperation({
        operation: operation
      });
  }

  if (
    !operation.response ||
    !Array.isArray(operation.response.generatedVideos) ||
    operation.response.generatedVideos.length === 0
  ) {
    throw new Error(
      "Veo n'a retourné aucune vidéo."
    );
  }

  const generatedVideo =
    operation.response.generatedVideos[0];

  if (!generatedVideo.video) {
    throw new Error(
      "Veo n'a pas retourné le fichier vidéo."
    );
  }

  const tempVideoPath =
    path.join(
      os.tmpdir(),
      `cineflow-veo-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.mp4`
    );

  try {

    await ai.files.download({
      file: generatedVideo.video,
      downloadPath: tempVideoPath
    });

    if (!fs.existsSync(tempVideoPath)) {
      throw new Error(
        "La vidéo Veo n'a pas pu être téléchargée."
      );
    }

    const videoData =
      fs.readFileSync(tempVideoPath);

    return {
      mimeType: "video/mp4",
      data: videoData.toString("base64")
    };

  } finally {

    try {
      fs.rmSync(
        tempVideoPath,
        {
          force: true
        }
      );
    } catch {}

  }
}


/*
=========================================================
FFMPEG
=========================================================
*/

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
          console.error(
            "FFmpeg :",
            stderr || error.message
          );

          reject(
            new Error(
              "Impossible de créer la vidéo."
            )
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


/*
=========================================================
PAGE PRINCIPALE
=========================================================
*/

app.get("/", (req, res) => {

  res.send(`
<!DOCTYPE html>

<html lang="fr">

<head>

  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <title>Cineflow</title>

  <style>

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: #0b1020;
      color: #ffffff;
    }

    header {
      padding: 22px 18px;
      text-align: center;
      border-bottom: 1px solid #202943;
      background: #0e1428;
    }

    header h1 {
      margin: 0;
      font-size: 30px;
    }

    header p {
      margin: 8px 0 0;
      color: #aeb8d0;
    }

    main {
      width: 100%;
      max-width: 900px;
      margin: auto;
      padding: 20px;
    }

    .card {
      background: #121a30;
      border: 1px solid #263250;
      border-radius: 18px;
      padding: 20px;
      margin-bottom: 18px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18);
    }

    h2 {
      margin-top: 0;
    }

    textarea {
      width: 100%;
      min-height: 150px;
      resize: vertical;
      background: #090e1c;
      color: white;
      border: 1px solid #34415f;
      border-radius: 12px;
      padding: 14px;
      font-size: 16px;
      outline: none;
    }

    textarea:focus {
      border-color: #6c8cff;
    }

    button {
      width: 100%;
      border: 0;
      border-radius: 12px;
      padding: 14px 16px;
      margin-top: 12px;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
      background: #5865f2;
      color: white;
    }

    button:hover:not(:disabled) {
      opacity: 0.9;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    .secondary {
      background: #263452;
    }

    .video-button {
      background: #7c4dff;
    }

    .veo-button {
      background: #a855f7;
    }

    .success {
      background: #123b2a;
      border: 1px solid #1d6849;
      color: #b7ffdc;
      padding: 12px;
      border-radius: 10px;
      margin-top: 12px;
    }

    .error {
      background: #421d25;
      border: 1px solid #71313e;
      color: #ffc3cb;
      padding: 12px;
      border-radius: 10px;
      margin-top: 12px;
    }

    .status {
      color: #b8c2da;
      margin-top: 12px;
      line-height: 1.5;
    }

    .project {
      white-space: pre-wrap;
      background: #080c17;
      border: 1px solid #28334e;
      border-radius: 12px;
      padding: 15px;
      line-height: 1.6;
      overflow-x: auto;
    }

    .scene {
      background: #0a1020;
      border: 1px solid #293653;
      border-radius: 12px;
      padding: 14px;
      margin-top: 12px;
    }

    .scene-title {
      font-weight: bold;
      margin-bottom: 8px;
      color: #8ea7ff;
    }

    .image-grid {
      display: grid;
      grid-template-columns: repeat(
        auto-fit,
        minmax(250px, 1fr)
      );
      gap: 15px;
      margin-top: 15px;
    }

    .image-card {
      background: #090e1c;
      border: 1px solid #2a3550;
      border-radius: 14px;
      overflow: hidden;
    }

    .image-card img {
      width: 100%;
      display: block;
      aspect-ratio: 16 / 9;
      object-fit: cover;
    }

    .image-card video {
      width: 100%;
      display: block;
      aspect-ratio: 16 / 9;
      object-fit: cover;
      background: #000;
    }

    .image-card p {
      padding: 10px;
      margin: 0;
      color: #c4cce0;
      font-size: 14px;
    }

    .badge {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      background: #263452;
      color: #cbd5ff;
      font-size: 13px;
      margin-bottom: 10px;
    }

    video {
      width: 100%;
      display: block;
      border-radius: 14px;
      margin-top: 15px;
      background: #000;
    }

    .download {
      display: block;
      text-align: center;
      text-decoration: none;
      width: 100%;
      border-radius: 12px;
      padding: 14px 16px;
      margin-top: 12px;
      font-size: 16px;
      font-weight: bold;
      background: #263452;
      color: white;
    }

    @media (max-width: 600px) {

      main {
        padding: 12px;
      }

      header h1 {
        font-size: 25px;
      }

      .card {
        padding: 15px;
      }

    }

  </style>

</head>


<body>


<header>

  <h1>🎬 Cineflow</h1>

  <p>
    Ton espace de création assistée par intelligence artificielle
  </p>

</header>


<main>


  <!-- GEMINI -->

  <div class="card">

    <span class="badge">
      🔌 Gemini
    </span>

    <h2>
      Connexion Gemini
    </h2>

    <button onclick="testerGemini()">
      ✨ Tester Gemini
    </button>

    <div
      id="geminiStatus"
      class="status"
    ></div>

  </div>


  <!-- PROJET -->

  <div class="card">

    <h2>
      🎥 Créer une vidéo
    </h2>

    <p>
      Décris simplement ton idée de film,
      d'animation, d'action, de drama ou de football.
    </p>

    <textarea
      id="idea"
      placeholder="Exemple : Un jeune footballeur africain rêve de devenir professionnel malgré les difficultés..."
    ></textarea>

    <button
      onclick="genererProjet()"
      id="generateProjectButton"
    >
      🚀 Générer mon projet
    </button>

    <div
      id="projectStatus"
      class="status"
    ></div>

    <div id="projectResult"></div>

  </div>


  <!-- PROMPTS -->

  <div class="card">

    <h2>
      🎬 Préparer les 5 scènes
    </h2>

    <p>
      Cineflow transforme automatiquement ton projet
      en 5 prompts visuels cohérents.
    </p>

    <button
      onclick="preparerImages()"
      id="prepareButton"
      disabled
    >
      🧩 Préparer les 5 scènes
    </button>

    <div
      id="prepareStatus"
      class="status"
    ></div>

    <div id="promptsResult"></div>

  </div>


  <!-- IMAGES -->

  <div class="card">

    <h2>
      🖼️ Générer les images
    </h2>

    <p>
      Lorsque les 5 scènes sont prêtes,
      Cineflow peut générer leurs images.
    </p>

    <button
      onclick="genererImages()"
      id="imagesButton"
      disabled
    >
      🎨 Générer les images
    </button>

    <div
      id="imagesStatus"
      class="status"
    ></div>

    <div id="imagesResult"></div>

  </div>


  <!-- ANIMATION VEO -->

  <div class="card">

    <span class="badge">
      🎞️ Veo 3.1
    </span>

    <h2>
      🎞️ Animer les 5 scènes
    </h2>

    <p>
      Cineflow transforme les images des scènes
      en véritables clips vidéo animés.
    </p>

    <button
      onclick="animerScenes()"
      id="animateButton"
      class="veo-button"
      disabled
    >
      🎞️ Animer les 5 scènes
    </button>

    <div
      id="animationStatus"
      class="status"
    ></div>

    <div id="animationResult"></div>

  </div>


  <!-- VIDEO -->

  <div class="card">

    <h2>
      🎬 Créer la vidéo
    </h2>

    <p>
      Cineflow assemble les 5 scènes dans
      une première vidéo MP4 au format 16:9.
    </p>

    <button
      onclick="creerVideo()"
      id="videoButton"
      class="video-button"
      disabled
    >
      🎬 Créer ma vidéo
    </button>

    <div
      id="videoStatus"
      class="status"
    ></div>

    <div id="videoResult"></div>

  </div>


</main>


<script>


/*
=========================================================
ÉTAT DU PROJET
=========================================================
*/

let dernierProjet = null;

let derniersPrompts = [];

let dernieresImages = [];

let derniersClips = [];


/*
=========================================================
TEST GEMINI
=========================================================
*/

async function testerGemini() {

  const status =
    document.getElementById("geminiStatus");

  status.className = "status";

  status.textContent =
    "⏳ Connexion à Gemini...";

  try {

    const response =
      await fetch("/api/test-gemini");

    const data =
      await response.json();

    if (!response.ok || !data.success) {

      throw new Error(
        data.error || "Erreur Gemini"
      );
    }

    status.className = "success";

    status.textContent =
      "✅ Gemini répond correctement.";

  } catch (error) {

    status.className = "error";

    status.textContent =
      "❌ " + error.message;
  }
}


/*
=========================================================
GÉNÉRER LE PROJET
=========================================================
*/

async function genererProjet() {

  const idea =
    document.getElementById("idea")
      .value
      .trim();

  const status =
    document.getElementById("projectStatus");

  const result =
    document.getElementById("projectResult");

  const projectButton =
    document.getElementById(
      "generateProjectButton"
    );

  const prepareButton =
    document.getElementById(
      "prepareButton"
    );

  const imagesButton =
    document.getElementById(
      "imagesButton"
    );

  const animateButton =
    document.getElementById(
      "animateButton"
    );

  const videoButton =
    document.getElementById(
      "videoButton"
    );


  if (!idea) {

    status.className = "error";

    status.textContent =
      "❌ Décris d'abord ton idée.";

    return;
  }


  dernierProjet = null;
  derniersPrompts = [];
  dernieresImages = [];
  derniersClips = [];


  prepareButton.disabled = true;
  imagesButton.disabled = true;
  animateButton.disabled = true;
  videoButton.disabled = true;

  projectButton.disabled = true;


  status.className = "status";

  status.textContent =
    "⏳ Gemini prépare ton projet...";

  result.innerHTML = "";


  try {

    const response =
      await fetch(
        "/api/generate",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            idea: idea
          })
        }
      );


    const data =
      await response.json();


    if (
      !response.ok ||
      !data.success
    ) {

      throw new Error(
        data.error ||
        "Impossible de générer le projet."
      );
    }


    dernierProjet =
      data.project;


    status.className =
      "success";

    status.textContent =
      "✅ Projet créé avec exactement 5 scènes.";


    let html = "";


    html +=
      "<div class='project'>";


    html +=
      "🎬 TITRE\\n";

    html +=
      (dernierProjet.title || "") +
      "\\n\\n";


    html +=
      "💡 CONCEPT\\n";

    html +=
      (dernierProjet.concept || "") +
      "\\n\\n";


    html +=
      "🎨 STYLE VISUEL\\n";

    html +=
      (dernierProjet.style || "") +
      "\\n\\n";


    html +=
      "👤 PERSONNAGES\\n";

    html +=
      (dernierProjet.characters || "") +
      "\\n\\n";


    html +=
      "📖 SCÉNARIO\\n";

    html +=
      (dernierProjet.scenario || "");


    html +=
      "</div>";


    html +=
      "<h3>🎞️ Les 5 scènes</h3>";


    for (let i = 0; i < 5; i++) {

      html +=
        "<div class='scene'>" +

          "<div class='scene-title'>" +
          "Scène " +
          (i + 1) +
          "</div>" +

          "<div>" +
          escapeHtml(
            dernierProjet.scenes[i]
          ) +
          "</div>" +

        "</div>";
    }


    result.innerHTML =
      html;


    prepareButton.disabled =
      false;


  } catch (error) {

    status.className =
      "error";

    status.textContent =
      "❌ " + error.message;


  } finally {

    projectButton.disabled =
      false;
  }
}


/*
=========================================================
PRÉPARER LES 5 PROMPTS
=========================================================
*/

async function preparerImages() {

  const status =
    document.getElementById(
      "prepareStatus"
    );

  const result =
    document.getElementById(
      "promptsResult"
    );

  const prepareButton =
    document.getElementById(
      "prepareButton"
    );

  const imagesButton =
    document.getElementById(
      "imagesButton"
    );

  const animateButton =
    document.getElementById(
      "animateButton"
    );

  const videoButton =
    document.getElementById(
      "videoButton"
    );


  if (!dernierProjet) {

    status.className =
      "error";

    status.textContent =
      "❌ Génère d'abord un projet.";

    return;
  }


  prepareButton.disabled = true;
  imagesButton.disabled = true;
  animateButton.disabled = true;
  videoButton.disabled = true;


  status.className =
    "status";

  status.textContent =
    "⏳ Préparation des 5 scènes visuelles...";


  result.innerHTML = "";


  try {

    const response =
      await fetch(
        "/api/prepare-images",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            project:
              dernierProjet
          })
        }
      );


    const data =
      await response.json();


    if (
      !response.ok ||
      !data.success
    ) {

      throw new Error(
        data.error ||
        "Impossible de préparer les scènes."
      );
    }


    if (
      !Array.isArray(
        data.prompts
      ) ||
      data.prompts.length !== 5
    ) {

      throw new Error(
        "Cineflow n'a pas reçu exactement 5 scènes."
      );
    }


    derniersPrompts =
      data.prompts;


    status.className =
      "success";

    status.textContent =
      "✅ Les 5 scènes sont prêtes.";


    let html = "";


    for (let i = 0; i < 5; i++) {

      html +=
        "<div class='scene'>" +

          "<div class='scene-title'>" +
          "🎬 Scène " +
          (i + 1) +
          "</div>" +

          "<div>" +
          escapeHtml(
            derniersPrompts[i]
          ) +
          "</div>" +

        "</div>";
    }


    result.innerHTML =
      html;


    imagesButton.disabled =
      false;


  } catch (error) {

    derniersPrompts = [];

    status.className =
      "error";

    status.textContent =
      "❌ " + error.message;

    imagesButton.disabled =
      true;

  } finally {

    prepareButton.disabled =
      false;
  }
}


/*
=========================================================
GÉNÉRER LES 5 IMAGES
=========================================================
*/

async function genererImages() {

  const status =
    document.getElementById(
      "imagesStatus"
    );

  const result =
    document.getElementById(
      "imagesResult"
    );

  const button =
    document.getElementById(
      "imagesButton"
    );

  const animateButton =
    document.getElementById(
      "animateButton"
    );

  const videoButton =
    document.getElementById(
      "videoButton"
    );


  if (
    !Array.isArray(
      derniersPrompts
    ) ||
    derniersPrompts.length !== 5
  ) {

    status.className =
      "error";

    status.textContent =
      "❌ Les 5 scènes ne sont pas encore prêtes.";

    button.disabled =
      true;

    return;
  }


  button.disabled = true;
  animateButton.disabled = true;
  videoButton.disabled = true;


  status.className =
    "status";

  status.textContent =
    "⏳ Génération des images... Cela peut prendre un moment.";


  result.innerHTML = "";


  try {

    const response =
      await fetch(
        "/api/generate-images",
        {

          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            prompts:
              derniersPrompts
          })

        }
      );


    const data =
      await response.json();


    if (
      !response.ok ||
      !data.success
    ) {

      throw new Error(
        data.error ||
        "Impossible de générer les images."
      );
    }


    if (
      !Array.isArray(
        data.images
      ) ||
      data.images.length !== 5
    ) {

      throw new Error(
        "Cineflow n'a pas reçu les 5 images."
      );
    }


    dernieresImages =
      data.images;


    let html =
      "<div class='success'>" +
      "✅ Les 5 images ont été générées." +
      "</div>";


    html +=
      "<div class='image-grid'>";


    for (
      let i = 0;
      i < data.images.length;
      i++
    ) {

      const image =
        data.images[i];


      html +=
        "<div class='image-card'>" +

          "<img src='data:" +
          image.mimeType +
          ";base64," +
          image.data +
          "' alt='Scène " +
          (i + 1) +
          "'>" +

          "<p>🎬 Scène " +
          (i + 1) +
          "</p>" +

        "</div>";
    }


    html +=
      "</div>";


    result.innerHTML =
      html;


    status.className =
      "success";

    status.textContent =
      "🎉 Cineflow a terminé la génération des 5 images.";


    animateButton.disabled =
      false;

    videoButton.disabled =
      false;


  } catch (error) {

    dernieresImages = [];

    status.className =
      "error";

    status.textContent =
      "❌ " + error.message;

    button.disabled =
      false;

  }
}


/*
=========================================================
ANIMER LES 5 SCÈNES AVEC VEO
=========================================================
*/

async function animerScenes() {

  const status =
    document.getElementById(
      "animationStatus"
    );

  const result =
    document.getElementById(
      "animationResult"
    );

  const button =
    document.getElementById(
      "animateButton"
    );

  const videoButton =
    document.getElementById(
      "videoButton"
    );


  if (
    !Array.isArray(
      dernieresImages
    ) ||
    dernieresImages.length !== 5
  ) {

    status.className =
      "error";

    status.textContent =
      "❌ Génère d'abord les 5 images.";

    return;
  }


  button.disabled = true;
  videoButton.disabled = true;

  derniersClips = [];

  result.innerHTML = "";

  status.className =
    "status";

  status.textContent =
    "⏳ Cineflow prépare l'animation des scènes...";


  try {

    for (let i = 0; i < 5; i++) {

      status.textContent =
        "🎞️ Animation de la scène " +
        (i + 1) +
        "/5...";


      const response =
        await fetch(
          "/api/animate-scene",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({

              image:
                dernieresImages[i],

              prompt:
                derniersPrompts[i] ||
                "Animation cinématographique naturelle, mouvements réalistes, caméra fluide, continuité visuelle avec l'image de départ."

            })
          }
        );


      const data =
        await response.json();


      if (
        !response.ok ||
        !data.success
      ) {

        throw new Error(
          data.error ||
          "Impossible d'animer la scène " +
          (i + 1) +
          "."
        );
      }


      derniersClips.push(
        data
      );


      let html =
        "<div class='success'>" +
        "✅ Scène " +
        (i + 1) +
        " animée." +
        "</div>";


      html +=
        "<div class='image-grid'>";


      for (
        let j = 0;
        j < derniersClips.length;
        j++
      ) {

        const clip =
          derniersClips[j];


        const videoUrl =
          "data:" +
          clip.mimeType +
          ";base64," +
          clip.data;


        html +=
          "<div class='image-card'>" +

            "<video controls playsinline src='" +
            videoUrl +
            "'></video>" +

            "<p>🎞️ Scène " +
            (j + 1) +
            "</p>" +

          "</div>";
      }


      html +=
        "</div>";


      result.innerHTML =
        html;
    }


    status.className =
      "success";

    status.textContent =
      "🎉 Les 5 scènes sont maintenant animées avec Veo.";


  } catch (error) {

    status.className =
      "error";

    status.textContent =
      "❌ " + error.message;

  } finally {

    button.disabled =
      false;

    videoButton.disabled =
      false;
  }
}


/*
=========================================================
CRÉER LA VIDÉO
=========================================================
*/

async function creerVideo() {

  const status =
    document.getElementById(
      "videoStatus"
    );

  const result =
    document.getElementById(
      "videoResult"
    );

  const button =
    document.getElementById(
      "videoButton"
    );


  if (
    !Array.isArray(
      dernieresImages
    ) ||
    dernieresImages.length !== 5
  ) {

    status.className =
      "error";

    status.textContent =
      "❌ Génère d'abord les 5 images.";

    return;
  }


  button.disabled =
    true;


  status.className =
    "status";

  status.textContent =
    "⏳ Cineflow assemble les 5 scènes en vidéo...";


  result.innerHTML =
    "";


  try {

    const response =
      await fetch(
        "/api/create-video",
        {

          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            images:
              dernieresImages
          })

        }
      );


    const data =
      await response.json();


    if (
      !response.ok ||
      !data.success
    ) {

      throw new Error(
        data.error ||
        "Impossible de créer la vidéo."
      );
    }


    const videoUrl =
      "data:" +
      data.mimeType +
      ";base64," +
      data.data;


    result.innerHTML =

      "<div class='success'>" +
      "🎉 Vidéo Cineflow créée !" +
      "</div>" +

      "<video controls playsinline src='" +
      videoUrl +
      "'></video>" +

      "<a class='download' " +
      "href='" +
      videoUrl +
      "' " +
      "download='cineflow-video.mp4'>" +
      "⬇️ Télécharger la vidéo" +
      "</a>";


    status.className =
      "success";

    status.textContent =
      "🎬 Première vidéo Cineflow terminée.";


  } catch (error) {

    status.className =
      "error";

    status.textContent =
      "❌ " + error.message;


    button.disabled =
      false;
  }
}


/*
=========================================================
PROTECTION HTML
=========================================================
*/

function escapeHtml(value) {

  return String(value || "")

    .replace(
      /&/g,
      "&amp;"
    )

    .replace(
      /</g,
      "&lt;"
    )

    .replace(
      />/g,
      "&gt;"
    )

    .replace(
      /"/g,
      "&quot;"
    )

    .replace(
      /'/g,
      "&#039;"
    );
}


</script>


</body>

</html>
  `);
});


/*
=========================================================
TEST GEMINI
=========================================================
*/

app.get(
  "/api/test-gemini",
  async (req, res) => {

    try {

      if (!API_KEY) {

        return res.status(500).json({
          success: false,
          error:
            "GEMINI_API_KEY n'est pas configurée sur Render."
        });
      }


      const interaction =
        await generateTextInteraction(

          "Réponds uniquement par cette phrase : Gemini est correctement connecté à Cineflow.",

          {
            type: "text"
          }

        );


      const text =
        getInteractionText(
          interaction
        );


      return res.json({
        success: true,
        message:
          text ||
          "Gemini répond correctement."
      });


    } catch (error) {

      console.error(
        "TEST GEMINI :",
        error
      );


      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Impossible de contacter Gemini."

      });

    }
  }
);


/*
=========================================================
GÉNÉRATION DU PROJET
=========================================================
*/

app.post(
  "/api/generate",
  async (req, res) => {

    try {

      const idea =
        typeof req.body?.idea === "string"
          ? req.body.idea.trim()
          : "";


      if (!idea) {

        return res.status(400).json({

          success: false,

          error:
            "L'idée du projet est obligatoire."

        });
      }


      const schema = {

        type: "object",

        properties: {

          title: {
            type: "string"
          },

          concept: {
            type: "string"
          },

          style: {
            type: "string"
          },

          characters: {
            type: "string"
          },

          scenario: {
            type: "string"
          },

          scenes: {

            type: "array",

            minItems: 5,

            maxItems: 5,

            items: {
              type: "string"
            }

          },

          thumbnail: {
            type: "string"
          },

          social: {
            type: "string"
          }

        },

        required: [
          "title",
          "concept",
          "style",
          "characters",
          "scenario",
          "scenes",
          "thumbnail",
          "social"
        ]

      };


      const prompt = `

Tu es le moteur créatif de Cineflow.

Crée un projet vidéo professionnel
à partir de cette idée :

"${idea}"

Le projet doit être entièrement en français.

IMPORTANT :

- Crée exactement 5 scènes.
- scenes doit contenir exactement 5 éléments.
- Chaque scène doit être suffisamment détaillée pour permettre ensuite de créer une image.
- Les 5 scènes doivent raconter une histoire cohérente.
- Les personnages doivent rester cohérents d'une scène à l'autre.
- Décris clairement les lieux, l'ambiance, les actions, la lumière et le cadrage.
- Ne crée aucune scène supplémentaire.

`;


      const interaction =
        await generateTextInteraction(

          prompt,

          {
            type: "text",
            mime_type:
              "application/json",
            schema:
              schema
          }

        );


      const rawText =
        getInteractionText(
          interaction
        );


      const project =
        JSON.parse(
          cleanJson(
            rawText
          )
        );


      if (
        !project ||
        !Array.isArray(
          project.scenes
        ) ||
        project.scenes.length !== 5
      ) {

        throw new Error(
          "Gemini n'a pas produit exactement 5 scènes."
        );
      }


      return res.json({

        success: true,

        project:
          project

      });


    } catch (error) {

      console.error(
        "GÉNÉRATION PROJET :",
        error
      );


      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Impossible de générer le projet."

      });

    }

  }
);


/*
=========================================================
PRÉPARATION DES IMAGES
=========================================================
*/

app.post(
  "/api/prepare-images",
  async (req, res) => {

    try {

      const project =
        req.body?.project;


      if (!project) {

        return res.status(400).json({

          success: false,

          error:
            "Projet manquant."

        });
      }


      if (
        !Array.isArray(
          project.scenes
        ) ||
        project.scenes.length !== 5
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Le projet doit contenir exactement 5 scènes."

        });
      }


      const schema = {

        type: "array",

        minItems: 5,

        maxItems: 5,

        items: {
          type: "string"
        }

      };


      const prompt = `

Tu es le directeur artistique de Cineflow.

À partir du projet vidéo ci-dessous,
crée EXACTEMENT 5 prompts destinés
à un modèle de génération d'images.

PROJET :

Titre :
${project.title}

Concept :
${project.concept}

Style visuel :
${project.style}

Personnages :
${project.characters}

Scénario :
${project.scenario}

SCÈNES :

1. ${project.scenes[0]}

2. ${project.scenes[1]}

3. ${project.scenes[2]}

4. ${project.scenes[3]}

5. ${project.scenes[4]}

RÈGLES IMPORTANTES :

- Retourne exactement 5 chaînes de texte.
- Une chaîne correspond à une seule scène.
- Le résultat doit être directement utilisable comme prompt d'image.
- Décris le personnage principal de manière cohérente dans les 5 scènes.
- Décris le lieu.
- Décris l'action.
- Décris l'éclairage.
- Décris l'ambiance.
- Décris le cadrage cinématographique.
- Style visuel cinématographique et professionnel.
- Format visuel pensé pour une vidéo 16:9.
- N'ajoute aucun commentaire.

`;


      const interaction =
        await generateTextInteraction(

          prompt,

          {
            type: "text",

            mime_type:
              "application/json",

            schema:
              schema

          }

        );


      const rawText =
        getInteractionText(
          interaction
        );


      const prompts =
        JSON.parse(
          cleanJson(
            rawText
          )
        );


      if (
        !Array.isArray(prompts) ||
        prompts.length !== 5
      ) {

        throw new Error(
          "Gemini n'a pas retourné exactement 5 prompts."
        );
      }


      const cleanedPrompts =
        prompts.map(
          (prompt) =>
            String(
              prompt || ""
            ).trim()
        );


      if (
        cleanedPrompts.some(
          (prompt) =>
            prompt.length < 10
        )
      ) {

        throw new Error(
          "Au moins un prompt de scène est vide ou incomplet."
        );
      }


      return res.json({

        success: true,

        prompts:
          cleanedPrompts

      });


    } catch (error) {

      console.error(
        "PRÉPARATION IMAGES :",
        error
      );


      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Impossible de préparer les 5 scènes."

      });

    }

  }
);


/*
=========================================================
GÉNÉRATION DES 5 IMAGES
=========================================================
*/

app.post(
  "/api/generate-images",
  async (req, res) => {

    try {

      const prompts =
        req.body?.prompts;


      if (!Array.isArray(prompts)) {

        return res.status(400).json({

          success: false,

          error:
            "Les prompts sont manquants."

        });
      }


      if (prompts.length !== 5) {

        return res.status(400).json({

          success: false,

          error:
            "Cineflow doit recevoir exactement 5 prompts."

        });
      }


      const images = [];


      for (
        let i = 0;
        i < prompts.length;
        i++
      ) {

        console.log(
          "🎨 Génération image",
          i + 1,
          "/ 5"
        );


        const prompt = `

Crée une image cinématographique professionnelle
pour la scène ${i + 1} d'un projet vidéo.

${prompts[i]}

IMPORTANT :

- Image cinématographique.
- Composition professionnelle.
- Format 16:9.
- Cohérence visuelle.
- Pas de texte.
- Pas de sous-titres.
- Pas de watermark ajouté par le prompt.

`;


        const image =
          await generateImage(
            prompt
          );


        images.push({

          scene:
            i + 1,

          mimeType:
            image.mimeType,

          data:
            image.data

        });

      }


      return res.json({

        success: true,

        images:
          images

      });


    } catch (error) {

      console.error(
        "GÉNÉRATION IMAGES :",
        error
      );


      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Impossible de générer les images."

      });

    }

  }
);


/*
=========================================================
ANIMATION D'UNE SCÈNE AVEC VEO
=========================================================
*/

app.post(
  "/api/animate-scene",
  async (req, res) => {

    try {

      const image =
        req.body?.image;

      const prompt =
        typeof req.body?.prompt === "string"
          ? req.body.prompt.trim()
          : "";


      if (!image?.data) {

        return res.status(400).json({

          success: false,

          error:
            "Image de scène manquante."

        });
      }


      if (!prompt) {

        return res.status(400).json({

          success: false,

          error:
            "Prompt d'animation manquant."

        });
      }


      const animationPrompt = `

Anime cette scène de manière cinématographique
et naturelle.

${prompt}

IMPORTANT :

- Conserve l'apparence des personnages.
- Conserve le décor.
- Conserve les vêtements.
- Conserve la lumière.
- Conserve le style visuel.
- Ajoute des mouvements réalistes.
- Ajoute un mouvement de caméra cinématographique.
- Évite les changements brusques d'identité.
- Évite de transformer le décor.
- Format 16:9.

`;


      console.log(
        "🎞️ Animation Veo en cours..."
      );


      const video =
        await generateVideoFromImage(
          image,
          animationPrompt
        );


      return res.json({

        success: true,

        mimeType:
          video.mimeType,

        data:
          video.data

      });


    } catch (error) {

      console.error(
        "ANIMATION VEO :",
        error
      );


      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Impossible d'animer la scène avec Veo."

      });

    }

  }
);


/*
=========================================================
CRÉATION VIDÉO
=========================================================

Première version du moteur vidéo :

5 images
↓
5 petits clips
↓
assemblage
↓
MP4 1280x720
=========================================================
*/

app.post(
  "/api/create-video",
  async (req, res) => {

    const tempDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "cineflow-"
        )
      );


    try {

      const images =
        req.body?.images;


      if (
        !Array.isArray(images) ||
        images.length !== 5
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Cineflow doit recevoir exactement 5 images."

        });
      }


      const segmentPaths = [];


      for (
        let i = 0;
        i < images.length;
        i++
      ) {

        const image =
          images[i];


        if (!image?.data) {

          throw new Error(
            `Image ${i + 1} invalide.`
          );
        }


        const imagePath =
          path.join(
            tempDir,
            `scene-${i + 1}.png`
          );


        const segmentPath =
          path.join(
            tempDir,
            `segment-${i + 1}.mp4`
          );


        fs.writeFileSync(

          imagePath,

          Buffer.from(
            image.data,
            "base64"
          )

        );


        console.log(
          `🎞️ Création du clip ${i + 1}/5`
        );


        await runFFmpeg([

          "-y",

          "-loop",
          "1",

          "-i",
          imagePath,

          "-t",
          "4",

          "-vf",
          "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",

          "-r",
          "24",

          "-c:v",
          "libx264",

          "-preset",
          "veryfast",

          "-pix_fmt",
          "yuv420p",

          "-movflags",
          "+faststart",

          segmentPath

        ]);


        segmentPaths.push(
          segmentPath
        );

      }


      const listPath =
        path.join(
          tempDir,
          "segments.txt"
        );


      const listContent =
        segmentPaths
          .map(
            (file) =>
              `file '${file.replace(
                /'/g,
                "'\\\\''"
              )}'`
          )
          .join("\n");


      fs.writeFileSync(
        listPath,
        listContent
      );


      const outputPath =
        path.join(
          tempDir,
          "cineflow.mp4"
        );


      console.log(
        "🎬 Assemblage de la vidéo finale..."
      );


      await runFFmpeg([

        "-y",

        "-f",
        "concat",

        "-safe",
        "0",

        "-i",
        listPath,

        "-c",
        "copy",

        "-movflags",
        "+faststart",

        outputPath

      ]);


      const videoData =
        fs.readFileSync(
          outputPath
        );


      console.log(
        "✅ Vidéo Cineflow créée."
      );


      return res.json({

        success: true,

        mimeType:
          "video/mp4",

        data:
          videoData.toString(
            "base64"
          )

      });


    } catch (error) {

      console.error(
        "CRÉATION VIDÉO :",
        error
      );


      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Impossible de créer la vidéo."

      });


    } finally {

      try {

        fs.rmSync(
          tempDir,
          {
            recursive: true,
            force: true
          }
        );

      } catch {}

    }

  }
);


/*
=========================================================
404
=========================================================
*/

app.use(
  (req, res) => {

    res.status(404).json({

      success: false,

      error:
        "Route introuvable."

    });

  }
);


/*
=========================================================
DÉMARRAGE
=========================================================
*/

app.listen(
  PORT,
  () => {

    console.log(
      "🎬 Cineflow API démarrée sur le port " +
      PORT
    );

    console.log(
      "🤖 Modèle texte : " +
      MODEL
    );

    console.log(
      "🎨 Modèle image : " +
      IMAGE_MODEL
    );

    console.log(
      "🎞️ Modèle vidéo : " +
      VIDEO_MODEL
    );

    console.log(
      "🎞️ FFmpeg : " +
      (ffmpegPath
        ? "disponible"
        : "indisponible")
    );

  }
);
