import mongoose, {isValidObjectId} from "mongoose"
import {Video} from "../models/video.model.js"
import {User} from "../models/user.model.js"
import {Like} from "../models/like.model.js"
import {Comment} from "../models/comment.model.js"
import {ApiError} from "../utils/ApiError.js"
import {ApiResponse} from "../utils/ApiResponse.js"
import {asyncHandler} from "../utils/asyncHandler.js"
import {uploadOnCloudinary} from "../utils/cloudinary.js"


const categoryKeywords = {
    all: [],
    music: ["music", "song", "album", "playlist", "audio"],
    gaming: ["gaming", "game", "playthrough", "fps", "walkthrough"],
    tech: ["tech", "developer", "coding", "programming", "ai", "software"],
    design: ["design", "ui", "ux", "motion", "branding"],
    news: ["news", "update", "breaking", "headline", "daily"],
    education: ["tutorial", "lesson", "course", "education", "guide", "learn"],
    sports: ["sports", "match", "highlights", "football", "cricket", "nba"],
    food: ["food", "cooking", "recipe", "meal", "chef"],
    lifestyle: ["vlog", "lifestyle", "daily", "routine", "personal"],
}

const escapeRegExp = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const buildKeywordMatch = (input) => {
    if (!input || input === "all") {
        return null
    }

    const normalized = input.toLowerCase()
    const keywords = categoryKeywords[normalized] || []

    // Priority 1: Match the explicit category field directly (case-insensitive)
    // Priority 2: Fallback to keyword matching in title/description
    const keywordMatches = keywords.flatMap((keyword) => [
        { title: new RegExp(escapeRegExp(keyword), "i") },
        { description: new RegExp(escapeRegExp(keyword), "i") },
        { tags: new RegExp(escapeRegExp(keyword), "i") }
    ])

    return {
        $or: [
            { category: new RegExp(`^${escapeRegExp(input)}$`, "i") },
            ...keywordMatches
        ],
    }
}

const buildVideoPipeline = ({
    query,
    category,
    excludeVideoId,
    sortBy = "createdAt",
    sortType = "desc",
}) => {
    const pipeline = []
    const matchConditions = [{ isPublished: true }]

    if (excludeVideoId && isValidObjectId(excludeVideoId)) {
        matchConditions.push({
            _id: { $ne: new mongoose.Types.ObjectId(excludeVideoId) },
        })
    }

    if (query?.trim()) {
        const searchRegex = new RegExp(escapeRegExp(query.trim()), "i")
        matchConditions.push({
            $or: [
                { title: searchRegex },
                { description: searchRegex },
                { tags: searchRegex },
                { category: searchRegex },
            ],
        })
    }

    const categoryMatch = buildKeywordMatch(category)
    if (categoryMatch) {
        matchConditions.push(categoryMatch)
    }

    pipeline.push({
        $match:
            matchConditions.length === 1 ? matchConditions[0] : { $and: matchConditions },
    })

    pipeline.push({
        $sort: {
            [sortBy]: sortType === "asc" ? 1 : -1,
            createdAt: -1,
        },
    })

    pipeline.push(
        {
            $lookup: {
                from: "likes",
                localField: "_id",
                foreignField: "video",
                as: "likes",
            },
        },
        {
            $lookup: {
                from: "comments",
                localField: "_id",
                foreignField: "video",
                as: "comments",
            },
        },
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "ownerDetails",
                pipeline: [
                    {
                        $project: {
                            username: 1,
                            fullName: 1,
                            avatar: 1,
                        },
                    },
                ],
            },
        },
        {
            $unwind: "$ownerDetails",
        },
        {
            $addFields: {
                likesCount: { $size: "$likes" },
                commentsCount: { $size: "$comments" },
            },
        },
        {
            $project: {
                likes: 0,
                comments: 0,
            },
        }
    )

    return pipeline
}


const getAllVideos = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, query, sortBy, sortType, category, userId } = req.query

    const pipeline = buildVideoPipeline({
        query,
        category,
        sortBy: sortBy || "createdAt",
        sortType: sortType || "desc",
    })

    if (userId) {
        if (!isValidObjectId(userId)) {
            throw new ApiError(400, "Invalid userId");
        }

        pipeline.unshift({
            $match: {
                owner: new mongoose.Types.ObjectId(userId)
            }
        })
    }

    const videoAggregate = Video.aggregate(pipeline);
    const options = {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10)
    };

    const video = await Video.aggregatePaginate(videoAggregate, options);

    return res
        .status(200)
        .json(new ApiResponse(200, video, "Videos fetched successfully"));
});

const getRecommendedVideos = asyncHandler(async (req, res) => {
    const { page = 1, limit = 8, query, category, isLive, seedVideoId } = req.query

    const pipeline = buildVideoPipeline({
        query,
        category,
        isLive,
        excludeVideoId: seedVideoId,
        sortBy: "views",
        sortType: "desc",
    })

    const videoAggregate = Video.aggregate(pipeline)
    const options = {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
    }

    const videos = await Video.aggregatePaginate(videoAggregate, options)

    return res
        .status(200)
        .json(new ApiResponse(200, videos, "Recommended videos fetched successfully"))
})


const publishAVideo = asyncHandler(async (req, res) => {
    const { title, description, category, tags, visibility, isForKids } = req.body
    
    if ([title, description, category].some((field) => field?.trim() === "")) {
        throw new ApiError(400, "Title, description and category are required");
    }

    const videoFileLocalPath = req.files?.videoFile[0].path;
    const thumbnailLocalPath = req.files?.thumbnail[0].path;

    if (!videoFileLocalPath) {
        throw new ApiError(400, "Video file is required");
    }

    if (!thumbnailLocalPath) {
        throw new ApiError(400, "Thumbnail is required");
    }

    const videoFile = await uploadOnCloudinary(videoFileLocalPath);
    const thumbnail = await uploadOnCloudinary(thumbnailLocalPath);

    if (!videoFile) {
        throw new ApiError(400, "Video upload failed");
    }

    if (!thumbnail) {
        throw new ApiError(400, "Thumbnail upload failed");
    }

    // Process tags: support both array and comma-separated string
    let parsedTags = [];
    if (tags) {
        parsedTags = Array.isArray(tags) 
            ? tags 
            : tags.split(",").map(tag => tag.trim()).filter(tag => tag !== "");
    }

    const video = await Video.create({
        title,
        description,
        category,
        tags: parsedTags,
        visibility: visibility || "public",
        isForKids: isForKids === "true" || isForKids === true,
        duration: videoFile.duration || 0,
        videoFile: videoFile.secure_url || videoFile.url,
        thumbnail: thumbnail.secure_url || thumbnail.url,
        owner: req.user?._id,
        isPublished: true
    });

    console.log("Video record established in database:", {
        id: video._id,
        title: video.title,
        url: video.videoFile
    });

    const videoUploaded = await Video.findById(video._id);

    if (!videoUploaded) {
        throw new ApiError(500, "Video record creation failed");
    }

    return res
        .status(200)
        .json(new ApiResponse(200, video, "Video uploaded successfully"));
});


const getVideoById = asyncHandler(async (req, res) => {
    const { videoId } = req.params
    //TODO: get video by id
     // userId = new mongoose.Types.ObjectId(userId)
     if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId");
    }

    const currentUserId = req.user?._id && isValidObjectId(req.user._id)
        ? new mongoose.Types.ObjectId(req.user._id)
        : null

    const video = await Video.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(videoId)
            }
        },
        {
            $lookup: {
                from: "likes",
                localField: "_id",
                foreignField: "video",
                as: "likes"
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "owner",
                pipeline: [
                    {
                        $lookup: {
                            from: "subscriptions",
                            localField: "_id",
                            foreignField: "channel",
                            as: "subscribers"
                        }
                    },
                    {
                        $addFields: {
                            subscribersCount: {
                                $size: "$subscribers"
                            },
                            isSubscribed: {
                                $cond: currentUserId
                                    ? {
                                        if: {
                                            $in: [
                                                currentUserId,
                                                "$subscribers.subscriber"
                                            ]
                                        },
                                        then: true,
                                        else: false
                                    }
                                    : false
                            }
                        }
                    },
                    {
                        $project: {
                            username: 1,
                            avatar: 1,
                            subscribersCount: 1,
                            isSubscribed: 1
                        }
                    }
                ]
            }
        },
        {
            $addFields: {
                likesCount: {
                    $size: "$likes"
                },
                owner: {
                    $first: "$owner"
                },
                isLiked: {
                    $cond: currentUserId
                        ? {
                            if: {$in: [currentUserId, "$likes.likedBy"]},
                            then: true,
                            else: false
                        }
                        : false
                }
            }
        },
        {
            $project: {
                videoFile: 1,
                thumbnail: 1,
                title: 1,
                description: 1,
                views: 1,
                createdAt: 1,
                duration: 1,
                comments: 1,
                owner: 1,
                likesCount: 1,
                isLiked: 1
            }
        }
    ]);
    if (!video?.length) {
        throw new ApiError(500, "failed to fetch video");
    }

    if (currentUserId) {
        // increment views if video fetched successfully
        await Video.findByIdAndUpdate(videoId, {
            $inc: {
                views: 1
            }
        });

        // add this video to user watch history
        await User.findByIdAndUpdate(currentUserId, {
            $addToSet: {
                watchHistory: videoId
            }
        });
    }

    return res
        .status(200)
        .json(
            new ApiResponse(200, video[0], "video details fetched successfully")
        );
});

const updateVideo = asyncHandler(async (req, res) => {
    const { videoId } = req.params
    //TODO: update video details like title, description, thumbnail
    const { title, description } = req.body;
    

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId");
    }

    if (!(title && description)) {
        throw new ApiError(400, "title and description are required");
    }

    const video = await Video.findById(videoId);

    if (!video) {
        throw new ApiError(404, "No video found");
    }

    if (video?.owner.toString() !== req.user?._id.toString()) {
        throw new ApiError(
            400,
            "You can't edit this video as you are not the owner"
        );
    }

     //deleting old thumbnail and updating with new one
     const thumbnailToDelete = video.thumbnail.public_id;

     const thumbnailLocalPath = req.file?.path;
 
     if (!thumbnailLocalPath) {
         throw new ApiError(400, "thumbnail is required");
     }
 
     const thumbnail = await uploadOnCloudinary(thumbnailLocalPath);
 
     if (!thumbnail) {
         throw new ApiError(400, "thumbnail not found");
     }
     const updatedVideo = await Video.findByIdAndUpdate(
        videoId,
        {
            $set: {
                title,
                description,
                thumbnail: {
                    public_id: thumbnail.public_id,
                    url: thumbnail.url
                }
            }
        },
        { new: true }
    );

    if (!updatedVideo) {
        throw new ApiError(500, "Failed to update video please try again");
    }

    if (updatedVideo) {
        await deleteOnCloudinary(thumbnailToDelete);
    }

    return res
        .status(200)
        .json(new ApiResponse(200, updatedVideo, "Video updated successfully")); 

})

const deleteVideo = asyncHandler(async (req, res) => {
    const { videoId } = req.params
    //TODO: delete video
   

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId");
    }

    const video = await Video.findById(videoId);

    if (!video) {
        throw new ApiError(404, "No video found");
    }

    if (video?.owner.toString() !== req.user?._id.toString()) {
        throw new ApiError(
            400,
            "You can't delete this video as you are not the owner"
        );
    }

    const videoDeleted = await Video.findByIdAndDelete(video?._id);

    if (!videoDeleted) {
        throw new ApiError(400, "Failed to delete the video please try again");
    }

    await deleteOnCloudinary(video.thumbnail.public_id); // video model has thumbnail public_id stored in it->check videoModel
    await deleteOnCloudinary(video.videoFile.public_id, "video"); // specify video while deleting video

    // delete video likes
    await Like.deleteMany({
        video: videoId
    })

    // delete video comments
    await Comment.deleteMany({
        video: videoId,
    })

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Video deleted successfully"));
})

const togglePublishStatus = asyncHandler(async (req, res) => {
    const { videoId } = req.params
   

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId");
    }

    const video = await Video.findById(videoId);

    if (!video) {
        throw new ApiError(404, "Video not found");
    }

    if (video?.owner.toString() !== req.user?._id.toString()) {
        throw new ApiError(
            400,
            "You can't toogle publish status as you are not the owner"
        );
    }

    const toggledVideoPublish = await Video.findByIdAndUpdate(
        videoId,
        {
            $set: {
                isPublished: !video?.isPublished
            }
        },
        { new: true }
    );

    if (!toggledVideoPublish) {
        throw new ApiError(500, "Failed to toogle video publish status");
    }

    return res
    .status(200)
    .json(
        new ApiResponse(
            200,
            { isPublished: toggledVideoPublish.isPublished },
            "Video publish toggled successfully"
        )
    );
})

export {
    getAllVideos,
    getRecommendedVideos,
    publishAVideo,
    getVideoById,
    updateVideo,
    deleteVideo,
    togglePublishStatus
}
