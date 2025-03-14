import getSupabaseClient from "../supabaseClient.js";

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];

  const supabase = getSupabaseClient(token);

  const { data: userData, error } = await supabase.auth.getUser(token);

  if (error || !userData?.user) {
    console.error("🔴 Invalid token. Trying refresh...");

    const refreshToken = req.headers["x-refresh-token"];
    if (!refreshToken) {
      console.error("🔴 No refresh token provided");
      return res.status(401).json({ error: "Unauthorized: Session expired" });
    }

    const { data: session, error: refreshError } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (refreshError || !session?.session) {
      console.error("🔴 Error refreshing session:", refreshError);
      return res.status(401).json({ error: "Unauthorized: Session expired" });
    }

    req.user = session.session.user;
    req.token = session.session.access_token;
  } else {
    req.user = userData.user;
    req.token = token;
  }

  next();
};

export default authMiddleware;
