import routes from "./routes.json";

const HARDCODED_FALLBACK = "chisholm2000@gmail.com";

export default {
  async email(message, env, ctx) {
    const to = (message.to || "").toLowerCase().trim();

    let destinations;
    try {
      destinations = routes[to];
      if (!destinations || !Array.isArray(destinations) || destinations.length === 0)
        destinations = routes._fallback;
      if (!destinations || !Array.isArray(destinations) || destinations.length === 0)
        destinations = [HARDCODED_FALLBACK];
    } catch (err) {
      destinations = [HARDCODED_FALLBACK];
    }

    await Promise.allSettled(
      destinations.map((dest) => message.forward(dest))
    );
  },
};
