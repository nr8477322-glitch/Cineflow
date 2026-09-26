const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("CineFlow API fonctionne !");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`CineFlow API démarrée sur le port ${PORT}`);
});
