import GameRoom from "@/components/game-room";

export default async function GamePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="h-screen overflow-hidden bg-[#161512] text-white">
      <GameRoom gameId={id} />
    </main>
  );
}