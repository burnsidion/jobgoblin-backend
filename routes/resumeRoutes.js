import express from "express";
import supabase from "../supabaseClient.js";
import authMiddleware from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
	const userId = req.user.id;

	const { data, error } = await supabase
		.from("resumes")
		.select("*")
		.eq("user_id", userId);

	if (error) return res.status(400).json({ error: error.message });

	res.status(200).json({ resumes: data });
});

export default router;
