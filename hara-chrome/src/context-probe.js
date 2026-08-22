import { createChatgptLoginService } from "./chatgpt-login-service.js";
import { createChatgptService } from "./chatgpt-service.js";
import { createDomExistenceProbe } from "./dom-existence-probe.js";
import { createDomService } from "./dom-service.js";
import { createTripoLoginService } from "./tripo-login-service.js";
import { createTripoService } from "./tripo-service.js";

export function createContextProbe({
  chromeApi,
  coordinator,
  owner = "hara-control-probe",
} = {}) {
  if (!chromeApi || !coordinator) throw new TypeError("createContextProbe requires Chrome and debugger coordinator");

  const domService = createDomService({ chromeApi, coordinator, owner });
  const existenceProbe = createDomExistenceProbe({ coordinator, owner });
  const loginDomService = {
    dispatch: (method, args, target) => method === "query-exists"
      ? existenceProbe.dispatch(method, args, target)
      : domService.dispatch(method, args, target),
  };
  const chatgptService = createChatgptService({ domService });
  const chatgptLogin = createChatgptLoginService({ domService: loginDomService, chatgptService });
  const tripoService = createTripoService({ domService });
  const tripoLogin = createTripoLoginService({ domService: loginDomService, tripoService });

  async function probe(classifiedTab) {
    const tabId = Number(classifiedTab?.id);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return { adapterState: "unavailable", authentication: null };
    }
    const target = { tabId };
    let status;
    if (classifiedTab.adapter === "chatgpt") {
      status = await chatgptLogin.dispatch("login-status", [], target);
    } else if (classifiedTab.adapter === "tripo") {
      status = await tripoLogin.dispatch("login-status", [], target);
    } else {
      return { adapterState: "none", authentication: null };
    }
    const authentication = status?.state ?? null;
    return {
      adapterState: status?.["signed-in?"] === true ? "ready" : authentication ?? "unavailable",
      authentication,
    };
  }

  async function close() {
    await Promise.allSettled([
      tripoLogin.close(),
      tripoService.close(),
      chatgptLogin.close(),
      chatgptService.close(),
      existenceProbe.close(),
      domService.close(),
      coordinator.releaseOwner(owner),
    ]);
    return true;
  }

  return { probe, close };
}
