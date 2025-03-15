import express from "express";
import getSupabaseClient from "../supabaseClient.js";
import authMiddleware from "../middleware/authMiddleware.js";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import cloudinary from "../cloudinaryConfig.js";
import fs from "fs";
import path from "path";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
router.get("/", authMiddleware, async (req, res) => {
	const userId = req.user.id;

	const { data, error } = await getSupabaseClient(
		process.env.SUPABASE_SERVICE_ROLE_KEY
	)
		.from("resumes")
		.select("*")
		.eq("user_id", userId);

	if (error) return res.status(400).json({ error: error.message });

	res.status(200).json({ resumes: data });
});

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
			const tempFilePath = path.join("/tmp", fileName); // Temporary file path

			// 🔹 Write file to disk temporarily
			fs.writeFileSync(tempFilePath, file.buffer);

			const supabaseAdmin = getSupabaseClient(
				process.env.SUPABASE_SERVICE_ROLE_KEY
			);

			// 🔹 Upload PDF to Supabase Storage
			const { data, error } = await supabaseAdmin.storage
				.from("resumes")
				.upload(`users/${userId}/${fileName}`, file.buffer, {
					contentType: file.mimetype,
				});

			if (error) {
				return res.status(500).json({ error: error.message });
			}

			const fileUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/resumes/users/${userId}/${fileName}`;

			// 🔹 Upload the first page of the PDF to Cloudinary as PNG (using local file path)
			const cloudinaryResponse = await cloudinary.uploader.upload(
				tempFilePath, // Use the temporary file path, NOT the buffer
				{
					folder: "resume_previews",
					resource_type: "image", // Ensure this is set to "image"
					format: "png", // Convert PDF to PNG
					pages: "1", // Upload only the first page
				}
			);

			if (!cloudinaryResponse.secure_url) {
				return res
					.status(500)
					.json({ error: "Failed to generate resume preview" });
			}

			const previewUrl = cloudinaryResponse.secure_url; // PNG URL

			// 🔹 Insert into Supabase database (including PNG preview URL)
			const { error: insertError } = await supabaseAdmin
				.from("resumes")
				.insert([
					{
						user_id: userId,
						resume_name: file.originalname,
						resume_file: fileUrl, // PDF file in Supabase
						preview_image: previewUrl, // PNG preview in Cloudinary
						file_type: file.mimetype,
					},
				]);

			if (insertError) {
				return res.status(500).json({ error: insertError.message });
			}

			// 🔹 Delete the temporary file after upload
			fs.unlinkSync(tempFilePath);

			res.status(201).json({
				message: "Resume uploaded successfully",
				fileUrl,
				previewUrl,
			});
		} catch (err) {
			console.error("Upload error:", err);
			res.status(500).json({ error: "Internal server error" });
		}
	}
);

export default router;
