import mongoose, { isValidObjectId } from "mongoose"
import {Tweet} from "../models/tweet.model.js"
import {User} from "../models/user.model.js"
import {ApiError} from "../utils/ApiError.js"
import {ApiResponse} from "../utils/ApiResponse.js"
import {asyncHandler} from "../utils/asyncHandler.js"

const createTweet = asyncHandler(async (req, res) => {
    //TODO: create tweet
    const { content } = req.body;

    if(!content){
        throw new ApiError(400, "content is required")
    }

    const tweet = await Tweet.create({
        content,
        owner: req.user?._id,
    });

    if(!tweet){
        throw new ApiError(404,"failed to create tweet Please try again.")
    }

    return res
    .status(200)
    .json(new ApiResponse(200, tweet,"tweet succesfully created."))
})

const getUserTweets = asyncHandler(async (req, res) => {
    // TODO: get user tweets
    const { userId } = req.params;

    if (!isValidObjectId(userId)) {
        throw new ApiError(400, "Invalid userId");
    }

    // Audit Discovery: Check if raw tweets exist for this userId before projection
    const rawCheck = await Tweet.find({ owner: userId }).limit(1);
    console.log(`[Diagnostic] Direct findOne check for owner ${userId}:`, rawCheck.length > 0 ? "Found" : "Not Found");

    const tweets = await Tweet.aggregate([
        {
            $match: {
                owner: new mongoose.Types.ObjectId(userId),
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
            $lookup: {
                from: "likes",
                localField: "_id",
                foreignField: "tweet",
                as: "likeDetails",
                pipeline: [
                    {
                        $project: {
                            likedBy: 1,
                        },
                    },
                ],
            },
        },
        {
            $addFields: {
                likesCount: {
                    $size: "$likeDetails",
                },
                ownerDetails: {
                    $first: "$ownerDetails",
                },
                isLiked: {
                    $cond: {
                        if: { $and: [
                            { $ne: [req.user?._id, undefined] },
                            { $in: [new mongoose.Types.ObjectId(req.user?._id), "$likeDetails.likedBy"] }
                        ]},
                        then: true,
                        else: false
                    }
                }
            },
        },
        {
            $sort: {
                createdAt: -1
            }
        },
        {
            $project: {
                content: 1,
                ownerDetails: 1,
                likesCount: 1,
                createdAt: 1,
                isLiked: 1
            },
        },
    ]);

    return res
        .status(200)
        .json(new ApiResponse(200, tweets, "Tweets fetched successfully"));
});

const getAllTweets = asyncHandler(async (req, res) => {
    // Get all tweets for the global feed
    const tweets = await Tweet.aggregate([
        {
            $sort: {
                createdAt: -1
            }
        },
        {
            $limit: 50
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
            $lookup: {
                from: "likes",
                localField: "_id",
                foreignField: "tweet",
                as: "likeDetails",
                pipeline: [
                    {
                        $project: {
                            likedBy: 1,
                        },
                    },
                ],
            },
        },
        {
            $addFields: {
                likesCount: {
                    $size: "$likeDetails",
                },
                ownerDetails: {
                    $first: "$ownerDetails",
                },
                isLiked: {
                    $cond: {
                        if: { $and: [
                            { $ne: [req.user?._id, undefined] },
                            { $in: [new mongoose.Types.ObjectId(req.user?._id), "$likeDetails.likedBy"] }
                        ]},
                        then: true,
                        else: false
                    }
                }
            },
        },
        {
            $project: {
                content: 1,
                ownerDetails: 1,
                likesCount: 1,
                createdAt: 1,
                isLiked: 1
            },
        },
    ]);

    return res
        .status(200)
        .json(new ApiResponse(200, tweets, "Global tweets fetched successfully"));
});

const updateTweet = asyncHandler(async (req, res) => {
    //TODO: update tweet
    const { content } = req.body;
    const { tweetId } = req.params;

    if(!content){
        throw new ApiError(400,"content not fetched")
    }

    if(!isValidObjectId(tweetId)){
        throw new ApiError(401,"Invalid tweet Id")
    }

    const tweet = await Tweet.findById(tweetId)

    if(!tweet){
        throw new ApiError(404,"tweet not found.")
    }

    if(tweet?.owner.toString() !== req.user?._id.toString()){
        throw new ApiError(400,"Only owner can edit this tweet.")
    }

    const newTweet = await Tweet.findByIdAndUpdate(
        tweetId,
        {
            $set: {
                content,
            },
        },
        { new: true }
    );

    if(!newTweet){
        throw new ApiError(500,"Failed to edit tweet Please try again.")
    }

    return res
    .status(200)
    .json(new ApiResponse(200, newTweet,"Tweet edit Succesfully."))
})


const deleteTweet = asyncHandler(async (req, res) => {
    //TODO: delete tweet
    const { tweetId } = req.params;
    if(!isValidObjectId(tweetId)){
        throw new ApiError(400, "Invalid tweet Id")
    }

    const tweet = await Tweet.findById(tweetId);
    if (!tweet) {
        throw new ApiError(404, "Tweet not found");
    }

    if (tweet?.owner?.toString() !== req.user?._id?.toString()) {
        throw new ApiError(403, "Only the owner can delete their tweet");
    }

    await Tweet.findByIdAndDelete(tweetId);

    return res
        .status(200)
        .json(new ApiResponse(200, {tweetId}, "Tweet deleted successfully"));
});

export {
    createTweet,
    getUserTweets,
    getAllTweets,
    updateTweet,
    deleteTweet
}
