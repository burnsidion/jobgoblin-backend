import {
	PDFDocument,
	StandardFonts,
	rgb,
	AnnotationFlags,
	PDFName,
	PDFDict,
} from "pdf-lib";
import express from "express";
import getSupabaseClient from "../supabaseClient.js";
import authMiddleware from "../middleware/authMiddleware.js";
import multer from "multer";
import openaiClient from "../utils/openaiClient.js";
import pdf from "pdf-text-extract";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname } from "path";

const pdfOptions = {
	exec: "/usr/local/bin/pdftotext",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const writeFileAsync = promisify(fs.writeFile);
const unlinkFileAsync = promisify(fs.unlink);

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

router.post(
	"/tailor-resume",
	authMiddleware,
	upload.single("resume_used"),
	async (req, res) => {
		try {
			const userId = req.user.id;
			const { job_description } = req.body;
			const resumeFile = req.file;

			if (!resumeFile || !job_description) {
				return res
					.status(400)
					.json({ error: "Resume and job description are required" });
			}

			let resumeText = "";
			try {
				const parsePDF = async (buffer) => {
					const tempFilePath = path.join(__dirname, "../temp_upload.pdf");

					try {
						await writeFileAsync(tempFilePath, buffer);

						return new Promise((resolve, reject) => {
							pdf(tempFilePath, pdfOptions, (err, text) => {
								unlinkFileAsync(tempFilePath).catch(console.error);
								if (err) {
									console.error("PDF Parsing Error:", err);
									reject("Failed to extract resume text.");
								} else {
									resolve(text);
								}
							});
						});
					} catch (err) {
						console.error("Error handling PDF file:", err);
						throw new Error("Failed to process PDF file.");
					}
				};

				resumeText = await parsePDF(resumeFile.buffer);
			} catch (err) {
				console.error("PDF Parsing Error:", err);
				return res
					.status(500)
					.json({ error: err || "Failed to extract resume text." });
			}

			// Make request to OpenAI API
			const response = await openaiClient.post("/chat/completions", {
				model: "gpt-4-turbo",
				messages: [
					{
						role: "system",
						content: `
							You are a professional resume tailoring assistant. Adjust the provided resume to align with the given job description.
							Format the response into the following clearly labeled sections:
							- ## Summary
							- ## Technical Skills
							- ## Work Experience
							- ## Education

							Ensure proper spacing and structure so that each section is clearly distinguishable.
							DO NOT include the candidate's name, contact information, or LinkedIn/Portfolio/GitHub links (these will be added separately).
							Extract and return any hyperlinks found in the resume immediately beneath the contact information.
						`,
					},
					{
						role: "user",
						content: `Here is my original resume (excluding my name & contact info):\n\n---\n${resumeText}\n---\n\nHere is the job description:\n\n---\n${job_description}\n---\n\nGenerate a **tailored** version of my resume that **aligns with the job description** while ensuring all of my original resume's **details, structure, and project descriptions remain intact**.`,
					},
				],
			});

			// Extract Hyperlinks
			let fullAIResponse = response.data.choices[0].message.content;
			let linkSectionIndex = fullAIResponse.lastIndexOf("Hyperlinks:");
			let tailoredResumeText =
				linkSectionIndex > -1
					? fullAIResponse.substring(0, linkSectionIndex).trim()
					: fullAIResponse.trim();

			let links = [];
			if (linkSectionIndex > -1) {
				let linkLines = fullAIResponse
					.substring(linkSectionIndex)
					.split("\n")
					.slice(1);
				links = linkLines
					.map((line) => line.match(/- (.+?): \[(.+?)\]/))
					.filter((match) => match)
					.map((match) => ({ label: match[1], url: match[2] }));
			}

			// Ensure hyperlinks are clickable and bold formatting is applied correctly
			let tailoredResumeTextProcessed = tailoredResumeText
				.replace(/[^\x00-\x7F]/g, "") // Remove non-ASCII characters
				.replace(/\r\n|\r/g, "\n") // Normalize newlines
				.replace(/\n{3,}/g, "\n\n") // Allow double newlines for section spacing
				.replace(/\*\*/g, "") // Remove rogue asterisks
				.replace(/### (.*?)\n/g, "$1\n") // Convert markdown headers
				.trim();

			// Generate a PDF
			const pdfDoc = await PDFDocument.create();
			const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
			const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
			const pageWidth = 600;
			const pageHeight = 800;
			const margin = 50;
			const lineHeight = 16; // Adjust line spacing
			const maxTextWidth = pageWidth - margin * 2;

			// Create first page
			let page = pdfDoc.addPage([pageWidth, pageHeight]);
			let y = pageHeight - margin; // Start from the top margin

			// Draw header (Centered Name & Contact Info)
			const titleFontSize = 18;
			const textFontSize = 12;

			page.drawText("Ian Burnside", {
				x: margin,
				y,
				size: titleFontSize,
				font,
			});
			y -= 25; // Move down after name

			const contactInfo = `Boulder, CO | 561-715-6031 | ian.burnside89@gmail.com`;
			page.drawText(contactInfo, {
				x: margin,
				y,
				size: textFontSize,
				font,
			});
			y -= 15; // Move down after contact info

			// Place Hyperlinks Beneath Header
			const linkSpacing = 80;
			links.forEach((link, index) => {
				page.drawText(link.label, {
					x: margin + index * linkSpacing,
					y,
					size: textFontSize,
					font: boldFont,
					color: rgb(0, 0, 1),
				});

				// Add clickable area for hyperlinks
				page.addAnnotation({
					type: "Link",
					rect: [
						margin + index * linkSpacing,
						y,
						margin + index * linkSpacing + 70,
						y + 12,
					],
					url: link.url,
				});
			});

			y -= 20; // Adjust spacing after hyperlinks

			// Function to wrap text onto new pages
			const addWrappedText = (text, font, page, y) => {
				const lines = text.split("\n");
				const titleFontSize = 14;
				const textFontSize = 12;
				for (const line of lines) {
					if (line.startsWith("## ")) {
						// Section headers (bold and larger font)
						y -= 30; // Extra spacing before headers
						page.drawText(line.replace("## ", ""), {
							x: 50,
							y,
							size: titleFontSize,
							font: boldFont,
							color: rgb(0, 0, 0),
						});
						y -= 20; // Extra spacing after headers
					} else {
						// Wrap text properly
						const words = line.split(" ");
						let currentLine = "";

						for (const word of words) {
							if (word.startsWith("**") && word.endsWith("**")) {
								const boldWord = word.slice(2, -2);
								const testLine = currentLine + boldWord + " ";
								const textWidth = boldFont.widthOfTextAtSize(
									testLine,
									textFontSize
								);

								if (textWidth > maxTextWidth) {
									// If text is too long, move to new line
									if (y - lineHeight * 2 < margin) {
										page = pdfDoc.addPage([pageWidth, pageHeight]);
										y = pageHeight - margin;
									}
									if (y < 50) {
										// If near bottom, start new page
										page = pdfDoc.addPage([600, 800]);
										y = page.getHeight() - 50;
									}
									page.drawText(currentLine.trim(), {
										x: 50,
										y,
										size: textFontSize,
										font,
									});
									y -= 15;
									currentLine = boldWord + " ";
								} else {
									currentLine = testLine;
								}
							} else {
								const testLine = currentLine + word + " ";
								const textWidth = font.widthOfTextAtSize(
									testLine,
									textFontSize
								);

								if (textWidth > maxTextWidth) {
									// If text is too long, move to new line
									if (y - lineHeight * 2 < margin) {
										page = pdfDoc.addPage([pageWidth, pageHeight]);
										y = pageHeight - margin;
									}
									if (y < 50) {
										// If near bottom, start new page
										page = pdfDoc.addPage([600, 800]);
										y = page.getHeight() - 50;
									}
									page.drawText(currentLine.trim(), {
										x: 50,
										y,
										size: textFontSize,
										font,
									});
									y -= 15;
									currentLine = word + " ";
								} else {
									currentLine = testLine;
								}
							}
						}

						if (currentLine.trim()) {
							if (y < 50) {
								page = pdfDoc.addPage([600, 800]);
								y = page.getHeight() - 50;
							}
							page.drawText(currentLine.trim(), {
								x: 50,
								y,
								size: textFontSize,
								font,
							});
							y -= 15;
						}
					}
				}
			};

			// Draw resume text with wrapping
			addWrappedText(tailoredResumeTextProcessed, font, page, y);

			const pdfBytes = await pdfDoc.save();

			// Send the PDF file as a response
			res.setHeader(
				"Content-Disposition",
				"attachment; filename=tailored_resume.pdf"
			);
			res.setHeader("Content-Type", "application/pdf");
			res.send(Buffer.from(pdfBytes));
		} catch (error) {
			console.error(
				"Error calling OpenAI:",
				error.response?.data || error.message
			);
			res.status(500).json({ error: "Failed to connect to OpenAI" });
		}
	}
);

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
