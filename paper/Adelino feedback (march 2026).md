
Review for the Authors

This paper addresses a highly relevant problem: how to maintain effective human oversight over large swarms of AI agents without sacrificing system throughput or the benefits of autonomy. The proposed Adaptive Stigmergic Oversight (ASO) framework is interesting and timely, and the paper is generally well written and easy to follow. In particular, the combination of intent-based delegation, stigmergic coordination through shared artifacts, and exception-based human review is a promising conceptual direction.

The main strength of the submission is its clear framing of the oversight problem and its attempt to unify ideas from supervisory control, adjustable autonomy, and stigmergic coordination into a single architecture. The paper also does a good job of motivating why scalable human oversight is becoming important for multi-agent AI systems.

However, the main limitation is that the paper currently reads more like a conceptual or position paper than a fully validated research contribution. The central claims are stronger than the evidence provided. In particular, the manuscript makes quantitative claims about efficiency and scalability, but does not include actual empirical validation, benchmark experiments, ablation studies, or human-subject evaluation to support them. The “proof-of-concept” section is closer to an implementation sketch than a scientific evaluation.

A second concern is that the mathematical analysis is too simplified to justify the stronger conclusions. The fan-out and efficiency formulation does not adequately account for queueing effects, reviewer bottlenecks, or scaling instability as the number of agents grows. As a result, the claim that efficiency remains effectively stable with increasing swarm size is not yet convincingly established.

The literature grounding is also somewhat limited for an AAMAS-style submission. While the paper cites relevant work in supervisory control and stigmergy, it would benefit from deeper engagement with prior work on teamwork, adjustable autonomy, human-agent interaction, and coordination in multi-agent systems. This would help clarify the paper’s precise novelty relative to existing research.

To strengthen the paper, I recommend reframing it more carefully as either a design/position paper or substantially extending it into a full empirical systems paper. In the latter case, the authors should add controlled experiments with meaningful baselines, clear task settings, scaling studies, and evaluation metrics covering not only task success and efficiency, but also false approvals, exception handling quality, human workload, and trust calibration. Theoretical claims should also be revised to include more realistic assumptions about review capacity, latency, and coordination overhead.

Overall, I find the core idea promising and potentially impactful, but the current version does not yet provide enough methodological or empirical support for its strongest claims. With a more cautious framing and substantially stronger validation, this work could become a valuable contribution.
