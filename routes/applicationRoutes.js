import express from "express";
import getSupabaseClient from "../supabaseClient.js";
import authMiddleware from "../middleware/authMiddleware.js";
import multer from "multer";


const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get("/", authMiddleware, async (req, res) => {
	const userId = req.user.id;

	const { data, error } = await getSupabaseClient(
		process.env.SUPABASE_SERVICE_ROLE_KEY
	)
		.from("applications")
		.select("*")
		.eq("user_id", userId);

	if (error) return res.status(400).json({ error: error.message });

	res.status(200).json({ resumes: data });
});

router.post("/", authMiddleware, async (req, res) => {
	try {
		const userId = req.user.id;

		const {
			company_name,
			job_title,
			job_link,
			job_description,
			date_applied,
			status,
			resume_used,
		} = req.body;

		const application = {
			user_id: userId,
			company_name,
			job_title,
			job_link,
			job_description,
			date_applied,
			status,
			resume_used,
		};

		const { data, error } = await getSupabaseClient(
			process.env.SUPABASE_SERVICE_ROLE_KEY
		)
			.from("applications")
			.insert([application]);

		if (error) {
			return res.status(500).json({ error: error.message });
		}

		res.status(201).json({ message: "Application created successfully", data });
	} catch (err) {
		console.error("error creating application:", err);
		res.status(500).json({ error: "Internal service error" });
	}
});

export default router;
