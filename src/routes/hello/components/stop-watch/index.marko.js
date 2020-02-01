// Compiled using marko@4.18.39 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require("marko/src/html").t(__filename),
    marko_component = {
    onCreate: function () {
        this.state = {
            running: false,
            elapsedTime: 0
        };
        this.intervalId = null;
    },
    onDestroy: function () {
        if (this.state.running) {
            clearInterval(this.intervalId);
        }
    },
    handleStartClick: function () {
        this.state.running = true;
        this.intervalId = setInterval(() => {
            this.state.elapsedTime += 0.1;
        }, 100);
    },
    handlePauseClick: function () {
        clearInterval(this.intervalId);
        this.state.running = false;
    },
    handleStopClick: function () {
        clearInterval(this.intervalId);
        this.state.running = false;
        this.state.elapsedTime = 0;
    }
},
    marko_componentType = "/app-a$1.0.0/src/routes/hello/components/stop-watch/index.marko",
    marko_renderer = require("marko/src/runtime/components/renderer"),
    helpers_escape_xml = require("marko/src/runtime/html/helpers/escape-xml"),
    marko_escapeXml = helpers_escape_xml.x,
    marko_attr = require("marko/src/runtime/html/helpers/attr");

function render(input, out, __component, component, state) {
  var data = input;

  out.w("<div><p>Elapsed time: " +
    marko_escapeXml(state.elapsedTime.toFixed(1)) +
    "s</p><button type=\"button\"" +
    marko_attr("disabled", state.running === true) +
    ">Start</button><button type=\"button\"" +
    marko_attr("disabled", state.running !== true) +
    ">Pause</button><button type=\"button\"" +
    marko_attr("disabled", (state.elapsedTime === 0) && (state.running === false)) +
    ">Stop/Clear</button></div>");
}

marko_template._ = marko_renderer(render, {
    ___type: marko_componentType
  }, marko_component);

marko_template.meta = {
    id: "/app-a$1.0.0/src/routes/hello/components/stop-watch/index.marko",
    component: "./"
  };
