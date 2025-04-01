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
			const tempFilePath = path.join("/tmp", fileName);

			// Write file to disk temporarily
			fs.writeFileSync(tempFilePath, file.buffer);

			const supabaseAdmin = getSupabaseClient(
				process.env.SUPABASE_SERVICE_ROLE_KEY
			);

			// Upload PDF to Supabase Storage
			const { data, error } = await supabaseAdmin.storage
				.from("resumes")
				.upload(`users/${userId}/${fileName}`, file.buffer, {
					contentType: file.mimetype,
				});

			if (error) {
				return res.status(500).json({ error: error.message });
			}

			const fileUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/resumes/users/${userId}/${fileName}`;

			// Upload the first page of the PDF to Cloudinary as PNG (using local file path)
			const cloudinaryResponse = await cloudinary.uploader.upload(
				tempFilePath,
				{
					folder: "resume_previews",
					resource_type: "image",
					format: "png",
					pages: "1",
				}
			);

			if (!cloudinaryResponse.secure_url) {
				return res
					.status(500)
					.json({ error: "Failed to generate resume preview" });
			}

			const previewUrl = cloudinaryResponse.secure_url;

			// Insert into Supabase database (including PNG preview URL)
			const { error: insertError } = await supabaseAdmin
				.from("resumes")
				.insert([
					{
						user_id: userId,
						resume_name: file.originalname,
						resume_file: fileUrl,
						preview_image: previewUrl,
						file_type: file.mimetype,
					},
				]);

			if (insertError) {
				return res.status(500).json({ error: insertError.message });
			}

			// Delete the temporary file after upload
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

router.post(
	"/upload-tailored",
	authMiddleware,
	upload.single("tailoredResume"),
	async (req, res) => {
		try {
			const applicationId = req.body.application_id;
			const userId = req.user.id;

			if (!applicationId) {
				return res.status(400).json({ error: "application_id is required" });
			}

			if (!req.file) {
				return res.status(400).json({ error: "No file uploaded" });
			}

			const file = req.file;
			const fileExtension = file.originalname.split(".").pop();
			const fileName = `${uuidv4()}.${fileExtension}`;
			const tempFilePath = path.join("/tmp", fileName);

			// Write the file buffer to disk temporarily
			fs.writeFileSync(tempFilePath, file.buffer);

			const supabaseAdmin = getSupabaseClient(
				process.env.SUPABASE_SERVICE_ROLE_KEY
			);
			// 1. Upload the PDF to Supabase Storage (tailored_resumes bucket)
			const { data: uploadData, error: uploadError } =
				await supabaseAdmin.storage
					.from("tailored-resumes")
					.upload(`users/${userId}/${fileName}`, file.buffer, {
						contentType: file.mimetype,
					});
			if (uploadError) {
				return res.status(500).json({ error: uploadError.message });
			}

			// Construct the public URL to the PDF
			const pdfUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/tailored-resumes/users/${userId}/${fileName}`;
			// 2. Generate a preview image via Cloudinary
			// Upload the first page of the PDF as a PNG preview image
			const cloudinaryResponse = await cloudinary.uploader.upload(
				tempFilePath,
				{
					folder: "tailored_resume_previews",
					resource_type: "image",
					format: "png",
					pages: "1",
				}
			);

			// Clean up the temporary file
			fs.unlinkSync(tempFilePath);

			if (!cloudinaryResponse.secure_url) {
				return res
					.status(500)
					.json({ error: "Failed to generate preview image" });
			}

			const previewUrl = cloudinaryResponse.secure_url;
			// 3. Insert a record into the tailored_resumes table
			const { data: insertData, error: insertError } = await supabaseAdmin
				.from("tailored_resumes")
				.insert([
					{
						application_id: applicationId,
						resume_file: pdfUrl,
						preview_image: previewUrl,
					},
				])
				.single();

			if (insertError) {
				console.log("insertError:", insertError);
				return res.status(500).json({ error: insertError.message });
			}

			return res.status(201).json({
				message: "Tailored resume uploaded successfully",
				data: insertData,
			});
		} catch (err) {
			console.error("Tailored resume upload error:", err);
			return res.status(500).json({ error: "Internal server error" });
		}
	}
);

router.delete("/:id", async (req, res) => {
	const { id } = req.params;

	if (!id) {
		return res.status(400).json({ error: "Resume ID is required" });
	}

	try {
		console.log(`Attempting to delete resume with ID: ${id}`);

		const supabase = getSupabaseClient(process.env.SUPABASE_SERVICE_ROLE_KEY);

		// Fetch the resume entry to get the storage path
		const { data: resume, error: fetchError } = await supabase
			.from("resumes")
			.select("id, resume_file")
			.eq("id", id)
			.single();

		if (fetchError || !resume) {
			console.error("Resume fetch error:", fetchError);
			return res.status(404).json({ error: "Resume not found" });
		}

		console.log("Resume found:", resume);

		// Extract the file name from the URL
		const filePath = resume.resume_file.split("/").pop();
		console.log("Extracted filePath:", filePath);

		// Delete from Supabase Storage
		const { error: storageError } = await supabase.storage
			.from("resumes")
			.remove([`users/${id}/${filePath}`]);

		if (storageError) {
			console.error("Storage deletion error:", storageError);
			return res
				.status(500)
				.json({ error: "Failed to delete file from storage" });
		}

		console.log("File deleted from storage");

		// Delete from database
		const { error: deleteError } = await supabase
			.from("resumes")
			.delete()
			.eq("id", id);

		if (deleteError) {
			console.error("Database deletion error:", deleteError);
			return res
				.status(500)
				.json({ error: "Failed to delete resume from database" });
		}

		console.log("Resume deleted from database");
		res.json({ message: "Resume deleted successfully" });
	} catch (error) {
		console.error("Unexpected server error:", error);
		res.status(500).json({ error: "Something went wrong" });
	}
});
export default router;
