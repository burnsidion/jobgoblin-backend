import express from "express";
import supabase from "../supabaseClient.js";
import authMiddleware from "../middleware/authMiddleware.js";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get("/", authMiddleware, async (req, res) => {
	const userId = req.user.id;

	const { data, error } = await supabase
		.from("resumes")
		.select("*")
		.eq("user_id", userId);

	if (error) return res.status(400).json({ error: error.message });

	res.status(200).json({ resumes: data });
});

// Upload Resume
router.post(
	"/upload",
	authMiddleware,
	upload.single("resume"),
	async (req, res) => {
		try {
			const userId = req.user.id;

			if (!req.file) {
				return res.status(400).json({ error: "No file uploaded" });
			}

			const file = req.file;
			const fileExtension = file.originalname.split(".").pop();
			const fileName = `${uuidv4()}.${fileExtension}`;

			// Upload to Supabase Storage
			const { data, error } = await supabase.storage
				.from("resumes")
				.upload(`users/${userId}/${fileName}`, file.buffer, {
					contentType: file.mimetype,
				});

			if (error) {
				return res.status(500).json({ error: error.message });
			}

			// Construct the file URL
			const fileUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/resumes/users/${userId}/${fileName}`;

			// Store metadata in the database
			const { error: dbError } = await supabase.from("resumes").insert([
				{
					user_id: userId,
					resume_name: file.originalname,
					resume_file: fileUrl,
					file_type: fileExtension,
				},
			]);

			if (dbError) {
				return res.status(500).json({ error: dbError.message });
			}

			res
				.status(201)
				.json({ message: "Resume uploaded successfully", fileUrl });
		} catch (err) {
			console.error("Upload error:", err);
			res.status(500).json({ error: "Internal server error" });
		}
	}
);

export default router;
