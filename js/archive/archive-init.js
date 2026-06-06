import { bootstrapPage } from "../core/app-bootstrap.js";
bootstrapPage({
  entryModules: [
    "./js/core/console-manager.js",
    "./js/archive/archive-page-manager.js",
  ],
});
