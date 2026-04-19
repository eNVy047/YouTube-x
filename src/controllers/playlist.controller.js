import mongoose, {isValidObjectId} from "mongoose"
import {Playlist} from "../models/playlist.model.js"
import {Video} from "../models/video.model.js"
import {Like} from "../models/like.model.js"
import {ApiError} from "../utils/ApiError.js"
import {ApiResponse} from "../utils/ApiResponse.js"
import {asyncHandler} from "../utils/asyncHandler.js"
const resolvePlaylistId = async (playlistId, userId) => {
    if (playlistId === "watch-later" || playlistId === "liked") {
        if (!userId) throw new ApiError(401, `Authentication required for ${playlistId}`);

        if (playlistId === "liked") return "liked";

        let watchLater = await Playlist.findOne({
            owner: userId,
            name: "Watch Later"
        });

        if (!watchLater) {
            try {
                watchLater = await Playlist.create({
                    name: "Watch Later",
                    description: "Videos to watch later",
                    owner: userId,
                    isPrivate: true
                });
            } catch (error) {
                // If parallel requests create it, just fetch it
                watchLater = await Playlist.findOne({
                    owner: userId,
                    name: "Watch Later"
                });
            }
        }
        return watchLater?._id;
    }

    if (!isValidObjectId(playlistId)) {
        throw new ApiError(400, "Invalid PlaylistId");
    }
    return playlistId;
};


const createPlaylist = asyncHandler(async (req, res) => {
    const {name, description, isPrivate} = req.body

    if(!name || !description){
        throw new ApiError(400,"name and description both are required.")
    }

    const playlist = await Playlist.create({
        name,
        description,
        isPrivate: isPrivate !== undefined ? isPrivate : true,
        owner: req.user?._id,
    });

    if(!playlist){
        throw new ApiError(204,"playlist creation failed")
    }

    return res
    .status(200)
    .json(new ApiResponse(200, playlist, "playlist created succesfully."))
})

const getUserPlaylists = asyncHandler(async (req, res) => {
    const {userId} = req.params
    //TODO: get user playlists
    if (!isValidObjectId(userId)) {
        throw new ApiError(400, "Invalid userId");
    }

    const playlists = await Playlist.aggregate([
        {
            $match: {
                owner: new mongoose.Types.ObjectId(userId),
                // If the requester is not the owner, only show public playlists
                ...(req.user?._id?.toString() !== userId ? { isPrivate: false } : {})
            }
        },
        {
            $lookup: {
                from: "videos",
                localField: "videos",
                foreignField: "_id",
                as: "videos"
            }
        },
        {
            $addFields: {
                totalVideos: {
                    $size: "$videos"
                },
                totalViews: {
                    $sum: "$videos.views"
                }
            }
        },
        {
            $project: {
                _id: 1,
                name: 1,
                description: 1,
                totalVideos: 1,
                totalViews: 1,
                updatedAt: 1
            }
        }
    ]);

    return res
    .status(200)
    .json(new ApiResponse(200, playlists, "User playlists fetched successfully"));

})

const getPlaylistById = asyncHandler(async (req, res) => {
    const {playlistId: rawId} = req.params

    if (rawId === "liked") {
        if (!req.user?._id) throw new ApiError(401, "Authentication required for Liked Videos");

        const likedVideos = await Like.aggregate([
            {
                $match: {
                    likedBy: new mongoose.Types.ObjectId(req.user._id)
                }
            },
            {
                $lookup: {
                    from: "videos",
                    localField: "video",
                    foreignField: "_id",
                    as: "videoDetails",
                    pipeline: [
                        {
                            $lookup: {
                                from: "users",
                                localField: "owner",
                                foreignField: "_id",
                                as: "owner"
                            }
                        },
                        { $unwind: "$owner" },
                        {
                            $project: {
                                username: 1,
                                fullName: 1,
                                avatar: 1
                            }
                        }
                    ]
                }
            },
            { $unwind: "$videoDetails" },
            { $sort: { createdAt: -1 } }
        ]);

        const virtualPlaylist = {
            _id: "liked",
            name: "Liked Videos",
            description: "Videos you have liked",
            owner: {
                _id: req.user._id,
                username: req.user.username,
                fullName: req.user.fullName,
                avatar: req.user.avatar
            },
            videos: likedVideos.map(l => l.videoDetails),
            totalVideos: likedVideos.length,
            totalViews: likedVideos.reduce((acc, curr) => acc + (curr.videoDetails.views || 0), 0),
            updatedAt: likedVideos[0]?.createdAt || new Date()
        };

        return res.status(200).json(new ApiResponse(200, virtualPlaylist, "Liked videos fetched successfully"));
    }

    const playlistId = await resolvePlaylistId(rawId, req.user?._id);

    if (!playlistId) {
        throw new ApiError(404, "Playlist not found")
    }

    const playlist = await Playlist.findById(playlistId);

    if (!playlist) {
        throw new ApiError(404, "Playlist not found");
    }

    if (playlist.isPrivate && playlist.owner.toString() !== req.user?._id?.toString()) {
        throw new ApiError(403, "This playlist is private");
    }

    const playlistVideos = await Playlist.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(playlistId)
            }
        },
        {
            $lookup: {
                from: "videos",
                localField: "videos",
                foreignField: "_id",
                as: "videos",
            }
        },
        {
            $match: {
                "videos.isPublished": true
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "owner",
            }
        },
        {
            $addFields: {
                totalVideos: {
                    $size: "$videos"
                },
                totalViews: {
                    $sum: "$videos.views"
                },
                owner: {
                    $first: "$owner"
                }
            }
        },
        {
            $project: {
                name: 1,
                description: 1,
                createdAt: 1,
                updatedAt: 1,
                totalVideos: 1,
                totalViews: 1,
                videos: {
                    _id: 1,
                    videoFile: 1,
                    thumbnail: 1,
                    title: 1,
                    description: 1,
                    duration: 1,
                    createdAt: 1,
                    views: 1
                },
                owner: {
                    username: 1,
                    fullName: 1,
                    avatar: 1
                }
            }
        }
        
    ]);

    return res
        .status(200)
        .json(new ApiResponse(200, playlistVideos[0], "playlist fetched successfully"));
});



const addVideoToPlaylist = asyncHandler(async (req, res) => {
    const {playlistId: rawId, videoId} = req.params
    
    const playlistId = await resolvePlaylistId(rawId, req.user?._id);

    if (playlistId === "liked") {
        if (!isValidObjectId(videoId)) throw new ApiError(400, "Invalid videoId");
        
        // Add like if it doesn't exist
        const existingLike = await Like.findOne({ video: videoId, likedBy: req.user._id });
        if (!existingLike) {
            await Like.create({ video: videoId, likedBy: req.user._id });
        }
        return res.status(200).json(new ApiResponse(200, {}, "Video liked successfully"));
    }

    if (!playlistId || !isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid PlaylistId or videoId");
    }

    const playlist = await Playlist.findById(playlistId);
    const video = await Video.findById(videoId);

    if (!playlist) {
        throw new ApiError(404, "Playlist not found");
    }
    if (!video) {
        throw new ApiError(404, "video not found");
    }

    if (playlist.owner.toString() !== req.user?._id.toString()) {
        throw new ApiError(400, "Only owner can add video to their playlist");
    }

    const updatedPlaylist = await Playlist.findByIdAndUpdate(
        playlist?._id,
        {
            $addToSet: {
                videos: videoId,
            },
        },
        { new: true }
    );

    if (!updatedPlaylist) {
        throw new ApiError(
            400,
            "failed to add video to playlist please try again"
        );
    }

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                updatedPlaylist,
                "Added video to playlist successfully"
            )
        );
})

const removeVideoFromPlaylist = asyncHandler(async (req, res) => {
    const {playlistId: rawId, videoId} = req.params
    
    const playlistId = await resolvePlaylistId(rawId, req.user?._id);

    if (playlistId === "liked") {
        if (!isValidObjectId(videoId)) throw new ApiError(400, "Invalid videoId");
        
        // Remove like
        await Like.findOneAndDelete({ video: videoId, likedBy: req.user._id });
        return res.status(200).json(new ApiResponse(200, {}, "Video removed from liked videos"));
    }

    if (!playlistId || !isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid PlaylistId or videoId");
    }

    const playlist = await Playlist.findById(playlistId);
    const video = await Video.findById(videoId);

    if (!playlist) {
        throw new ApiError(404, "Playlist not found");
    }
    if (!video) {
        throw new ApiError(404, "video not found");
    }

    if (playlist.owner.toString() !== req.user?._id.toString()) {
        throw new ApiError(
            404,
            "Only owner can remove video from their playlist"
        );
    }

    const updatedPlaylist = await Playlist.findByIdAndUpdate(
        playlistId,
        {
            $pull: {
                videos: videoId,
            },
        },
        { new: true }
    );

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                updatedPlaylist,
                "Removed video from playlist successfully"
            )
        );

})

const deletePlaylist = asyncHandler(async (req, res) => {
    const {playlistId} = req.params
    // TODO: delete playlist
    

    if (!isValidObjectId(playlistId)) {
        throw new ApiError(400, "Invalid PlaylistId");
    }

    const playlist = await Playlist.findById(playlistId);

    if (!playlist) {
        throw new ApiError(404, "Playlist not found");
    }

    if (playlist.owner.toString() !== req.user?._id.toString()) {
        throw new ApiError(400, "only owner can delete the playlist");
    }

    await Playlist.findByIdAndDelete(playlist?._id);

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {},
                "playlist updated successfully"
            )
        );
})

const updatePlaylist = asyncHandler(async (req, res) => {
    const {playlistId} = req.params
    const {name, description, isPrivate} = req.body
    
    if (!name || !description) {
        throw new ApiError(400, "name and description both are required");
    }

    if (!isValidObjectId(playlistId)) {
        throw new ApiError(400, "Invalid PlaylistId");
    }

    const playlist = await Playlist.findById(playlistId);

    if (!playlist) {
        throw new ApiError(404, "Playlist not found");
    }

    if (playlist.owner.toString() !== req.user?._id.toString()) {
        throw new ApiError(400, "only owner can edit the playlist");
    }

    const updatedPlaylist = await Playlist.findByIdAndUpdate(
        playlist?._id,
        {
            $set: {
                name,
                description,
                isPrivate: isPrivate !== undefined ? isPrivate : playlist.isPrivate
            },
        },
        { new: true }
    );

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                updatedPlaylist,
                "playlist updated successfully"
            )
        );
})

export {
    createPlaylist,
    getUserPlaylists,
    getPlaylistById,
    addVideoToPlaylist,
    removeVideoFromPlaylist,
    deletePlaylist,
    updatePlaylist
}
