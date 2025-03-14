import express from "express";
import getSupabaseClient from "../supabaseClient.js";
import authMiddleware from "../middleware/authMiddleware.js";

const router = express.Router();

// User Signup
router.post("/signup", async (req, res) => {
	const supabase = getSupabaseClient();
	const { email, password, first_name, last_name } = req.body;

	const { data, error } = await supabase.auth.signUp({ email, password });

	if (error) return res.status(400).json({ error: error.message });

	const userId = data.user?.id;
	if (userId) {
		const { error: insertError } = await supabase
			.from("users")
			.insert([{ id: userId, email, first_name, last_name }]);

		if (insertError)
			return res.status(400).json({ error: insertError.message });
	}

	const { user, session } = data;

	if (!session) {
		return res
			.status(400)
			.json({ error: "Signup successful, but no session returned" });
	}

	res.status(201).json({
		user,
		access_token: session.access_token,
		refresh_token: session.refresh_token,
		expires_in: session.expires_in,
	});
});

// User Login
router.post("/login", async (req, res) => {
	const supabase = getSupabaseClient();
	const { email, password } = req.body;

	const { data, error } = await supabase.auth.signInWithPassword({
		email,
		password,
	});

	if (error) return res.status(400).json({ error: error.message });

	const { user, session } = data;

	if (!session) {
		return res
			.status(400)
			.json({ error: "Authentication failed, no session returned" });
	}

	res.json({
		user,
		access_token: session.access_token,
		refresh_token: session.refresh_token,
		expires_in: session.expires_in,
	});
});

// User Logout
router.post("/logout", authMiddleware, async (req, res) => {
	const supabase = getSupabaseClient(req.token);

	const { error } = await supabase.auth.signOut();

	if (error) return res.status(400).json({ error: error.message });

	res.status(200).json({ message: "Logged out successfully" });
});

// Get Profile (Protected Route)
router.get("/profile", authMiddleware, async (req, res) => {
	res.json({ user: req.user });
});

export default router;
