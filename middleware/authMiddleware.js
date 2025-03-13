import supabase from "../supabaseClient.js";

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];

  // Verify the Supabase JWT
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }

  // Attach user to the request object
  req.user = data.user;
  next();
};

export default authMiddleware;
