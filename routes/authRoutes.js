import express from "express";
import supabase from "../supabaseClient.js";
import authMiddleware from "../middleware/authMiddleware.js";

const router = express.Router();

// User Signup
router.post("/signup", async (req, res) => {
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

	res.status(201).json({ user: data.user });
});

// User Login
router.post("/login", async (req, res) => {
	const { email, password } = req.body;

	const { data, error } = await supabase.auth.signInWithPassword({
		email,
		password,
	});

	if (error) return res.status(400).json({ error: error.message });

	res.json({ user: data });
});

router.get("/profile", authMiddleware, async (req, res) => {
	res.json({ user: req.user });
});

export default router;
