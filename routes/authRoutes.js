import express from "express";
import supabase from "../supabaseClient.js";

const router = express.Router();

// User Signup
router.post("/signup", async (req, res) => {
	const { email, password, first_name, last_name } = req.body;

	// Sign up the user with Supabase Auth
	const { data, error } = await supabase.auth.signUp({ email, password });

	if (error) return res.status(400).json({ error: error.message });

	// If signup was successful, insert user into "users" table
	const userId = data.user?.id; // Get the user ID from Supabase auth
	if (userId) {
		const { error: insertError } = await supabase
			.from("users")
			.insert([{ id: userId, email, first_name, last_name }]); // 🔹 Removed "password"

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

export default router;
