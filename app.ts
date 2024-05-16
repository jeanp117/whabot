// import { Flujos } from "./flowSedes";
import { idleFlow, reset, start } from "./iddle";
import { Flow } from "./types";
import { getPathImage } from "./utils";
const {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  EVENTS,
} = require("@bot-whatsapp/bot");

// const QRPortalWeb = require("@bot-whatsapp/portal");
const BaileysProvider = require("@bot-whatsapp/provider/baileys");

//basic express server

const express = require("express");
const app = express();
const port = 3000;

const MockAdapter = require("@bot-whatsapp/database/mock");

const config = require("./page/config.json");
let state = {
  deviceConnected: false,
  flujosLoaded: false,
  flujos: [],
} as any;

let flujosIndice = {};
let flujosKeywords: Set<string> = new Set();
let flujosArray: Flow[] = [];
fetch(config.FLUJOS_URL as string)
  .then((response) => response.json())
  .then((data: Flow[]) => {
    flujosArray = data;
    console.log(flujosArray.length + " Flujos cargados correctamente");
    console.log(flujosArray.map((flow) => flow.name));
    state.flujosLoaded = true;
    state.flujos = flujosArray.map((flow) => flow.name);
  })
  .catch((error) => {
    state.flujosLoaded = false;
    console.error("No se pudo cargar los flujos");
  });

flujosArray.map((flow) => {
  if (flow.keywords)
    Array.from(flow.keywords).forEach((keyword) => flujosKeywords.add(keyword));

  let flujo = addKeyword(flow.keywords ? flow.keywords : EVENTS.ACTION);
  // for of with key value
  if (flow.body) {
    for (let index = 0; index < flow.body.length; index++) {
      const message = flow.body[index];
      const isLast = index === flow.body.length - 1;
      flujo = flujo.addAnswer(message.text, {
        media: message.media?.includes("http")
          ? message.media
          : message.media
          ? getPathImage(message.media)
          : undefined,
        delay: message.delay || undefined,
        capture: isLast ? flow.capture : false,
      });
    }
  }

  flujo = flujo.addAction(
    async (ctx, { flowDynamic, gotoFlow, state, fallBack }) => {
      //se actualiza el flujo anterior
      try {
        state.update({ previousFlow: state.get("currentFlow") });
      } catch (error) {}
      state.update({ currentFlow: flow.name });

      if (flow.action) {
        if (typeof flow.action === "string") {
          let action = new Function(
            "{ ctx, gotoFlow, state, fallBack, flowDynamic }",
            `
        ${flow.action}
      `
          );
          action(ctx, { gotoFlow, state, fallBack, flowDynamic });
        }

        if (typeof flow.action === "function") {
          flow.action(ctx, { gotoFlow, state, fallBack, flowDynamic });
        }
      }

      if (!flow.capture) return;

      if (flow.timeout) {
        start(ctx, gotoFlow, flow.timeout || 30000);
        reset(ctx, gotoFlow, flow.timeout || 30000);
      }

      let userResponse = textNormalizer(ctx.body + "");
      if (!flow.options) return;

      let optionFound = flow.options.find((option) => {
        //si es estricto, debe ser exactamente igual, si no se permite que el texto del usuario contenga la palabra clave
        return option.keywords.find((keyword) => {
          if (option.strict == false) {
            return userResponse.includes(textNormalizer(keyword));
          } else {
            return userResponse === textNormalizer(keyword);
          }
        });
      });

      if (optionFound) {
        if (optionFound.response) {
          for (let index = 0; index < optionFound.response.length; index++) {
            const message = optionFound.response[index];

            await flowDynamic(message.text, {
              media: message.media?.includes("http")
                ? message.media
                : message.media
                ? getPathImage(message.media)
                : undefined,
              delay: message.delay || undefined,
            });
          }
        }
        //TO DO: implementar actions aqui

        //si la opción encontrada tiene un flujo siguiente, se redirige al flujo
        if (optionFound.nextFlow) {
          let flowName = optionFound.nextFlow as string;
          let nextFlow = flujosIndice[flowName];

          if (!nextFlow) {
            throw new Error("No se encontró el flujo");
          } else {
            return gotoFlow(nextFlow);
          }
        }

        if (optionFound.goBack) {
          let previousFlow = state.get("previousFlow");
          if (previousFlow && flujosIndice[previousFlow])
            gotoFlow(flujosIndice[previousFlow]);
        }
        return;
      } else {
        //si la respuesta del usuario es una palabra clave, no se procesa
        if (flujosKeywords.has(userResponse)) return;

        //si la opción no es válida, se anula el cambio  flujo actual y se pone el anterior
        state.update({ currentFlow: state.get("previousFlow") });
        //si la respuesta del usuario no es una palabra clave, se ejecuta el fallback del flujo
        return await fallBack(
          flow.fallBack || `*${userResponse}* no es una opción válida.`
        );
      }
    }
  );

  flujosIndice[flow.name] = flujo;
  return flujo;
});

const textNormalizer = (text: string) => {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
};

const main = async () => {
  const adapterDB = new MockAdapter();
  const adapterFlow = createFlow([...flujosArray, idleFlow]);
  const adapterProvider = createProvider(BaileysProvider);

  let bot = createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

  adapterProvider._events.require_action = () => {
    console.log("Whatsapp Bot no enlazado. Escanea el código QR.");
  };

  adapterProvider._events.ready = () => {
    console.log("Whatsapp Bot está listo!");
    state.deviceConnected = true;
  };

  adapterProvider._events.auth_failure = (error) => {
    console.error("Error de autenticación: " + error);
  };

  app.get("/qr", (req, res) => {
    //send qr code "bot.qr.png" to the client on upper level
    // root should be the root of the project
    res.sendFile("bot.qr.png", { root: __dirname });
  });

  app.get("/status", (req, res) => {
    //send qr code "bot.qr.png" to the client
    res.send(state);
  });

  app.get("/", (req, res) => {
    //send html on page
    res.sendFile("/page/index.html", { root: __dirname });
  });

  app.get("/restart", (req, res) => {
    //restart the nodejs server
    res.send("Reiniciando el servidor");
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });

  app.get("/testBot", async (req, res) => {
    if (state.deviceConnected == false)
      return res.send({ data: "No hay dispositivo conectado" });
    let phone = req.query.phone;
    await adapterProvider.sendText(
      "57" + phone + "@c.us",
      "¡Hola, soy el bot! 🤖"
    );
    res.send({ data: "enviado!" });
  });

  app.get("/disconnect", (req, res) => {
    //delete bot session folder
    const fs = require("fs-extra");
    //for linux and windows resolve path
    //bot_session folder is at the root of the project

    fs.rm(__dirname + "/bot_sessions", { recursive: true });
    state.deviceConnected = false;
    res.send("Dispositivo desconectado");
    //restart the nodejs server

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });

  app.listen(port, () => {
    // current ip

    let ip = require("ip");
    console.log(`Administrador corriendo en http://${ip.address()}:${port}`);
  });
};

main();
