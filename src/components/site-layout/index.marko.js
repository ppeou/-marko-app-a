// Compiled using marko@4.18.39 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require("marko/src/html").t(__filename),
    marko_componentType = "/app-a$1.0.0/src/components/site-layout/index.marko",
    marko_renderer = require("marko/src/runtime/components/renderer"),
    marko_dynamicTag = require("marko/src/runtime/helpers/dynamic-tag"),
    marko_loadTag = require("marko/src/runtime/helpers/load-tag"),
    lasso_head_tag = marko_loadTag(require("@lasso/marko-taglib/taglib/head-tag")),
    component_globals_tag = marko_loadTag(require("marko/src/core-tags/components/component-globals-tag")),
    asset_var_tag = marko_loadTag(require("@lasso/marko-taglib/taglib/asset-var/renderer")),
    marko_attr = require("marko/src/runtime/html/helpers/attr"),
    lasso_body_tag = marko_loadTag(require("@lasso/marko-taglib/taglib/body-tag")),
    init_components_tag = marko_loadTag(require("marko/src/core-tags/components/init-components-tag")),
    await_reorderer_tag = marko_loadTag(require("marko/src/core-tags/core/await/reorderer-renderer"));

function render(input, out, __component, component, state) {
  var data = input;

  out.w("<!DOCTYPE html><html lang=\"en-US\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>");

  marko_dynamicTag(out, input.title, null, null, null, null, __component, "5");

  out.w("</title>");

  lasso_head_tag({}, out, __component, "6");

  out.w("</head><body>");

  component_globals_tag({}, out);

  out.w("<header>");

  asset_var_tag({
      values: [
          require.resolve("./logo.png")
        ],
      renderBody: function renderBody(out, __src) {
        out.w("<img" +
          marko_attr("src", __src.url) +
          " alt=\"marko logo\" class=\"logo\">");
      }
    }, out, __component, "20");

  out.w("<h1>");

  marko_dynamicTag(out, input.title, null, null, null, null, __component, "11");

  out.w("</h1><nav class=\"menu\"><a href=\"/\">home</a><a href=\"/hello/routing\">routes</a><a href=\"/layouts\">layouts</a></nav></header><div class=\"content\">");

  marko_dynamicTag(out, input.content, null, null, null, null, __component, "17");

  out.w("</div>");

  lasso_body_tag({}, out, __component, "18");

  init_components_tag({}, out);

  await_reorderer_tag({}, out, __component, "19");

  out.w("</body></html>");
}

marko_template._ = marko_renderer(render, {
    ___implicit: true,
    ___type: marko_componentType
  });

marko_template.meta = {
    deps: [
      "./style.css"
    ],
    id: "/app-a$1.0.0/src/components/site-layout/index.marko",
    tags: [
      "@lasso/marko-taglib/taglib/head-tag",
      "marko/src/core-tags/components/component-globals-tag",
      "@lasso/marko-taglib/taglib/asset-var/renderer",
      "@lasso/marko-taglib/taglib/body-tag",
      "marko/src/core-tags/components/init-components-tag",
      "marko/src/core-tags/core/await/reorderer-renderer"
    ]
  };
