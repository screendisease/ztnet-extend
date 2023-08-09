/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import * as ztController from "~/utils/ztApi";
import { prisma } from "../db";
import { APIError, throwError } from "../helpers/errorHandler";
import { Peers } from "~/types/local/member";

// This function checks if the given IP address is likely a private IP address
function isPrivateIP(ip: string): boolean {
	const ipInt = ip
		.split(".")
		.reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
	const ranges = [
		{ start: 10 << 24, end: (10 << 24) + (1 << 24) - 1 },
		{
			start: (172 << 24) + (16 << 16),
			end: (172 << 24) + (31 << 16) + (1 << 16) - 1,
		},
		{
			start: (192 << 24) + (168 << 16),
			end: (192 << 24) + (168 << 16) + (1 << 16) - 1,
		},
	];

	return ranges.some((range) => ipInt >= range.start && ipInt <= range.end);
}

export enum ConnectionStatus {
	Offline = 0,
	Relayed = 1,
	DirectLAN = 2,
	DirectWAN = 3,
}

function determineConnectionStatus(peer: Peers): ConnectionStatus {
	if (Array.isArray(peer) && peer.length === 0) {
		return ConnectionStatus.Offline;
	}

	if (peer?.latency === -1 || peer?.versionMajor === -1) {
		return ConnectionStatus.Relayed;
	}

	// Check if at least one path has a private IP
	if (peer?.paths && peer.paths.length > 0) {
		for (const path of peer.paths) {
			const ip = path.address.split("/")[0];
			if (isPrivateIP(ip)) {
				return ConnectionStatus.DirectLAN;
			}
		}
	}

	return ConnectionStatus.DirectWAN;
}

interface MemberI {
	id: string;
	peers: Record<any, any>;
	nwid: string;
	address: string;
	conStatus: number;
}

export const fetchZombieMembers = async (
	ctx: any,
	input: any,
	enrichedMembers: any[],
) => {
	const getZombieMembersPromises = enrichedMembers.map((member) => {
		return ctx.prisma.network_members.findFirst({
			where: {
				nwid: input.nwid,
				id: member.id,
				deleted: true,
			},
		});
	});

	const zombieMembers = await Promise.all(getZombieMembersPromises);
	return zombieMembers.filter(Boolean);
};

export const enrichMembers = async (
	ctx: any,
	input: any,
	controllerMembers: any[],
	peersByAddress: Record<string, any>,
) => {
	const memberPromises = controllerMembers.map(async (member: any) => {
		const dbMember = await ctx.prisma.network_members.findFirst({
			where: { nwid: input.nwid, id: member.id },
			include: { notations: { include: { label: true } } },
		});

		if (!dbMember) return []; // member doesn't belong to the specific user

		const peers = peersByAddress[dbMember.address] || [];

		let activePreferredPath: any;
		if ("paths" in peers && peers.paths.length > 0) {
			activePreferredPath = peers.paths.find(
				(path: any) => path.active && path.preferred,
			);
		}

		if (!activePreferredPath) return { ...dbMember, ...member, peers: {} };

		const { address: physicalAddress, ...restOfActivePreferredPath } =
			activePreferredPath;

		return {
			...dbMember,
			...member,
			peers: { ...peers, physicalAddress, ...restOfActivePreferredPath },
		};
	});

	return await Promise.all(memberPromises);
};

export const fetchPeersForAllMembers = async (
	members: any[],
): Promise<Record<string, any>> => {
	const memberAddresses = members.map((member) => member.address);
	const peerPromises = memberAddresses.map((address) =>
		ztController.peer(address).catch(() => null),
	);

	const peers = await Promise.all(peerPromises);
	const peersByAddress: Record<string, any> = {};

	memberAddresses.forEach((address, index) => {
		peersByAddress[address] = peers[index];
	});

	return peersByAddress;
};

export const updateNetworkMembers = async (
	zt_controller: any,
	peersByAddress: Record<string, any>,
) => {
	if (!zt_controller.members || zt_controller.members.length === 0) return;

	for (const member of zt_controller.members) {
		member.peers = peersByAddress[member.address] || [];
		member.conStatus = determineConnectionStatus(member.peers);
	}

	await psql_updateMember(zt_controller.members);
};

const psql_updateMember = async (members: any[]): Promise<void> => {
	for (const member of members) {
		const storeValues: any = {
			id: member.id,
			address: member.address,
		};

		if (member.peers && member.conStatus !== 0) {
			storeValues.lastSeen = new Date();
		}

		const updateMember = await prisma.network_members.updateMany({
			where: { nwid: member.nwid, id: member.id },
			data: storeValues,
		});

		if (!updateMember.count) {
			try {
				await psql_addMember(member);
			} catch (error) {
				// rome-ignore lint/nursery/noConsoleLog: <explanation>
				console.log(error);
			}
		}
	}
};

const psql_addMember = async (member: MemberI) => {
	return await prisma.network_members.create({
		data: {
			id: member.id,
			lastSeen: new Date(),
			creationTime: new Date(),
			nwid_ref: {
				connect: { nwid: member.nwid },
			},
		},
	});
};

function ip2long(ip: string) {
	const parts = ip.split(".");
	let res = 0;
	res += parseInt(parts[0]) << 24;
	res += parseInt(parts[1]) << 16;
	res += parseInt(parts[2]) << 8;
	res += parseInt(parts[3]);
	return res >>> 0; // Convert to unsigned number
}

function long2ip(long: number) {
	const part1 = (long & 255).toString();
	const part2 = ((long >> 8) & 255).toString();
	const part3 = ((long >> 16) & 255).toString();
	const part4 = ((long >> 24) & 255).toString();

	return `${part4}.${part3}.${part2}.${part1}`;
}

// Function to get the next available IP from a range
// Function to get the next available IP from a list of ranges
export function getNextIP(
	ranges: { ipRangeStart: string; ipRangeEnd: string }[],
	allAssignedIPs: string[],
): string | null {
	// For each range in the list of ranges
	for (const range of ranges) {
		const start = ip2long(range.ipRangeStart);
		const end = ip2long(range.ipRangeEnd);

		for (let ipLong = start; ipLong <= end; ipLong++) {
			const ip = long2ip(ipLong);
			if (!allAssignedIPs.includes(ip)) {
				return ip;
			}
		}
	}

	// If we haven't returned by now, then there are no available IPs in the range
	return null;
}

/**
 * Checks and manages the auto-assignment of IP addresses to network members.
 *
 * The function receives a boolean `autoAssignIp`. If `autoAssignIp` is not set or false, it will
 * clear any existing IP assignment pools for network members. This is achieved by setting the
 * `ipAssignmentPools` of the ztControllerUpdates to an empty array.
 *
 * If `autoAssignIp` is true, the function will create a new IP assignment pool, update the network
 * with the new pool, fetch network details, and assign IPs to members without an assigned IP.
 *
 * The function first gathers all assigned IPs in the network. Then, for each member without an IP,
 * it tries to assign an available IP from the pool.
 *
 */
// export async function handleAutoAssignIP(
//   ztControllerUpdates: Partial<ZtControllerNetwork>,
//   ztControllerResponse,
//   nwid: string
// ) {
//   // get the last route from the controller response
//   const routes = ztControllerResponse.network.routes.pop();

//   // we cannot assign ip if no routes are found
//   if (!Array.isArray(routes)) {
//     return;
//   }
//   // else update network with new ipAssignmentPools
//   const pool = IPv4gen(routes["target"]);
//   ztControllerUpdates.ipAssignmentPools =
//     pool.ipAssignmentPools as IpAssignmentPoolsEntity[];

//   const controller = await ztController
//     .network_detail(nwid)
//     .catch((err: APIError) => {
//       throw new TRPCError({
//         message: `${err.cause.toString()} --- ${err.message}`,
//         code: "BAD_REQUEST",
//         cause: err.cause,
//       });
//     });

//   // First, gather all assigned IPs in the network
//   let allAssignedIPs: string[] = [];
//   for (const member of controller?.members) {
//     allAssignedIPs = [...allAssignedIPs, ...member.ipAssignments];
//   }

//   // Then, for each member without an IP, try to assign one
//   for (const member of controller?.members) {
//     if (member.noAutoAssignIps) continue;

//     if (member.ipAssignments.length === 0) {
//       // Get next available IP from the pool
//       const nextIP = getNextIP(pool.ipAssignmentPools, allAssignedIPs);

//       if (nextIP !== null) {
//         // If a next IP is available, assign it to the member
//         await ztController.member_update(nwid, member.id, {
//           ipAssignments: [nextIP],
//         });
//         // Add this newly assigned IP to the allAssignedIPs array, to keep it up-to-date
//         allAssignedIPs.push(nextIP);
//       }
//     }
//   }
// }
