import { type FC } from 'react';
import AgentBiChartRenderer from './AgentBiChartRenderer';
import {
    buildAgentBiQueryOutput,
    type AgentBiQueryPreview,
} from './agentBiQueryArtifact';

type Props = {
    preview: AgentBiQueryPreview;
};

const AgentBiQueryArtifact: FC<Props> = ({ preview }) => (
    <AgentBiChartRenderer
        output={buildAgentBiQueryOutput(preview)}
        title="Query result"
    />
);

export default AgentBiQueryArtifact;
